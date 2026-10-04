import Foundation

/// Main-actor intent admission, separate from SDK acknowledgement and SwiftUI visibility.
@MainActor
final class HostRouteLifetime {
    struct Intent: Equatable {
        fileprivate let owner: UUID
        fileprivate let generation: Int
    }

    private let owner = UUID()
    private var generation = 0
    private(set) var active = true
    private var editor: (() -> Void)?
    private var saveAndRetire: ((@escaping @MainActor () -> Bool) async -> Bool)?
    private var suspendRoute: (() -> Void)?
    private var restoreRoute: (() -> Void)?
    private var routeSuspended = false
    var hasEditor: Bool { editor != nil }
    var currentIntent: Intent { Intent(owner: owner, generation: generation) }

    private var startupIntent: Intent { Intent(owner: owner, generation: 0) }

    @discardableResult
    func restoreDefault<Value>(load: () async -> Value, apply: (Value) -> Void) async -> Bool {
        let intent = startupIntent
        guard accepts(intent), !Task.isCancelled else { return false }
        let value = await load()
        guard accepts(intent), !Task.isCancelled else { return false }
        apply(value)
        return true
    }

    func begin() -> Intent? {
        guard active else { return nil }
        // A keeper navigation (e.g. Settings) must not leave its retained editor
        // on a notification's SDK generation. Restore before granting next intent.
        restoreEditorRoute(currentIntent)
        generation += 1
        return Intent(owner: owner, generation: generation)
    }

    func accepts(_ intent: Intent) -> Bool {
        active && intent.owner == owner && intent.generation == generation
    }

    func acceptsProducer(_ route: Int, current: Int) -> Bool {
        active && route == current
    }

    func installEditor(
        saveAndRetire: ((@escaping @MainActor () -> Bool) async -> Bool)? = nil,
        suspendRoute: (() -> Void)? = nil,
        restoreRoute: (() -> Void)? = nil,
        retire: @escaping () -> Void
    ) {
        guard active else { retire(); return }
        retireEditor()
        editor = retire
        self.saveAndRetire = saveAndRetire
        self.suspendRoute = suspendRoute
        self.restoreRoute = restoreRoute
    }

    func suspendEditorRoute(_ intent: Intent) {
        guard accepts(intent), !routeSuspended, editor != nil else { return }
        routeSuspended = true
        suspendRoute?()
    }

    func restoreEditorRoute(_ intent: Intent) {
        guard accepts(intent), routeSuspended else { return }
        routeSuspended = false
        restoreRoute?()
    }

    func prepareReplacement(_ intent: Intent) async -> Bool {
        guard accepts(intent), !Task.isCancelled else { return false }
        if let saveAndRetire {
            guard await saveAndRetire({ self.accepts(intent) && !Task.isCancelled }) else {
                restoreEditorRoute(intent)
                return false
            }
        }
        guard accepts(intent), !Task.isCancelled else { return false }
        retireEditor()
        return true
    }

    func retireEditor() {
        let previous = editor
        editor = nil
        saveAndRetire = nil
        suspendRoute = nil
        restoreRoute = nil
        routeSuspended = false
        previous?()
    }

    func retire() {
        guard active else { return }
        active = false
        generation += 1
        retireEditor()
    }
}

/// Shared by the view and deterministic save/intent interleaving tests.
@MainActor
@discardableResult
func completeSavedNavigation(
    save: () async -> Bool,
    isCurrent: () -> Bool,
    navigate: () -> Void
) async -> Bool {
    guard !Task.isCancelled, isCurrent() else { return false }
    let saved = await save()
    guard saved, !Task.isCancelled, isCurrent() else { return false }
    navigate()
    return true
}
