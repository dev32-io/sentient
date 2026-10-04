// Pure check: swiftc ios/App/Nav/HostRouteLifetime.swift ios/checks/host-route-lifetime.swift -o /tmp/host-route-check && /tmp/host-route-check
import Foundation

@main
struct HostRouteLifetimeCheck {
    @MainActor
    static func main() async {
        // Hold real startup admission helper across both restore/ACK orderings.
        for restoreFirst in [true, false] {
            let host = HostRouteLifetime()
            var selected = "default"
            var continuation: CheckedContinuation<Void, Never>?
            let restore = Task { @MainActor in
                await host.restoreDefault(
                    load: { await withCheckedContinuation { continuation = $0 } },
                    apply: { _ in selected = "restored" }
                )
            }
            while continuation == nil { await Task.yield() }
            let notification = host.begin()!
            if restoreFirst {
                continuation!.resume()
                let applied = await restore.value
                precondition(!applied)
                if host.accepts(notification) { selected = "notification" }
            } else {
                if host.accepts(notification) { selected = "notification" }
                continuation!.resume()
                let applied = await restore.value
                precondition(!applied)
            }
            precondition(selected == "notification")
        }
        let defaultHost = HostRouteLifetime()
        var restored = false
        let applied = await defaultHost.restoreDefault(load: { 1 }, apply: { restored = $0 == 1 })
        precondition(applied && restored)

        // Exercise the actual async navigation helper used by ChatView, holding
        // its save completion until notification/settings/new navigation wins.
        for target in ["history", "new-chat"] {
            let host = HostRouteLifetime()
            let intent = host.begin()!
            var selected = "A"
            var continuation: CheckedContinuation<Bool, Never>?
            let saving = Task { @MainActor in
                await completeSavedNavigation(
                    save: { await withCheckedContinuation { continuation = $0 } },
                    isCurrent: { host.accepts(intent) },
                    navigate: { selected = target }
                )
            }
            while continuation == nil { await Task.yield() }
            _ = host.begin()
            selected = "notification-C"
            continuation!.resume(returning: true)
            let navigated = await saving.value
            precondition(!navigated && selected == "notification-C")
        }

        // Notification SDK mutation is bracketed by the same host intent. Failed
        // preparation and keeper supersession restore once; retirement never does.
        for superseded in [false, true] {
            let host = HostRouteLifetime()
            var suspended = 0
            var restored = 0
            var retired = 0
            var release: CheckedContinuation<Bool, Never>?
            host.installEditor(
                saveAndRetire: { _ in await withCheckedContinuation { release = $0 } },
                suspendRoute: { suspended += 1 }, restoreRoute: { restored += 1 },
                retire: { retired += 1 })
            let notification = host.begin()!
            host.suspendEditorRoute(notification)
            let preparing = Task { await host.prepareReplacement(notification) }
            while release == nil { await Task.yield() }
            if superseded { _ = host.begin() }
            release!.resume(returning: false)
            let replaced = await preparing.value
            precondition(!replaced && host.hasEditor && retired == 0)
            precondition(suspended == 1 && restored == 1)
            host.restoreEditorRoute(notification) // old/duplicate completion is inert
            precondition(restored == 1)
            let next = host.begin()!
            host.suspendEditorRoute(next)
            host.retire()
            precondition(restored == 1 && retired == 1)
        }

        let oldHost = HostRouteLifetime()
        let oldIntent = oldHost.begin()!
        var retired = 0
        oldHost.installEditor { retired += 1 }
        _ = oldHost.begin() // settings/inbox navigation is not editor retirement
        precondition(retired == 0)
        oldHost.retireEditor() // same-session replacement
        precondition(retired == 1)
        oldHost.installEditor { retired += 1 }
        precondition(!oldHost.acceptsProducer(1, current: 3)) // A -> B -> A
        precondition(oldHost.acceptsProducer(3, current: 3))
        oldHost.retire()
        oldHost.retire()
        precondition(retired == 2 && !oldHost.accepts(oldIntent))
        precondition(oldHost.begin() == nil)
        let successor = HostRouteLifetime()
        precondition(!successor.accepts(oldIntent))
        precondition(!oldHost.acceptsProducer(3, current: 3))
        oldHost.installEditor { retired += 1 }
        precondition(retired == 3) // deferred factory cannot resurrect retired owner

        var navigated = false
        let failed = await completeSavedNavigation(save: { false }, isCurrent: { true }, navigate: { navigated = true })
        precondition(!failed && !navigated)
        let retried = await completeSavedNavigation(save: { true }, isCurrent: { true }, navigate: { navigated = true })
        precondition(retried && navigated)
        print("Host route lifetime checks passed")
    }
}
