// ---------------------------------------------------------------------------
// SideDrawer — SwiftUI bridge over the native UIKit SideDrawerController.
//
// Wraps `content` (the chat column) and `drawer` (the History side panel) in
// UIHostingControllers and drives the interactive native drawer. SwiftUI commands
// open/close through `isOpen`; the controller clears `isOpen` to false on any
// interactive dismiss (drag/tap), and calls `onOpen` whenever the drawer settles
// fully open (edge-swipe OR programmatic) so the host can refresh on every open.
//
// Stateful-content note: HistorySidePanel observes HistoryModel via @ObservedObject.
// SwiftUI re-evaluates the @ViewBuilder closures whenever the host re-renders;
// updateUIViewController reassigns each hosting controller's rootView so those
// fresh subtrees (with up-to-date observed state) propagate into UIKit. Without
// the reassignment the hosted trees would freeze at make-time state.
// ---------------------------------------------------------------------------
import SwiftUI

struct SideDrawer<Content: View, Drawer: View>: UIViewControllerRepresentable {
    @Binding var isOpen: Bool
    let onOpen: () -> Void
    @ViewBuilder let content: () -> Content
    @ViewBuilder let drawer: () -> Drawer

    init(
        isOpen: Binding<Bool>,
        onOpen: @escaping () -> Void,
        @ViewBuilder content: @escaping () -> Content,
        @ViewBuilder drawer: @escaping () -> Drawer
    ) {
        self._isOpen = isOpen
        self.onOpen = onOpen
        self.content = content
        self.drawer = drawer
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(isOpen: $isOpen, onOpen: onOpen)
    }

    func makeUIViewController(context: Context) -> SideDrawerController {
        let contentHost = UIHostingController(rootView: content())
        let drawerHost = UIHostingController(rootView: drawer())
        contentHost.view.backgroundColor = .clear
        drawerHost.view.backgroundColor = .clear
        context.coordinator.contentHost = contentHost
        context.coordinator.drawerHost = drawerHost

        let controller = SideDrawerController(content: contentHost, drawer: drawerHost)
        controller.onOpen = { context.coordinator.handleOpened() }
        controller.onDismiss = { context.coordinator.handleDismissed() }
        return controller
    }

    func updateUIViewController(_ controller: SideDrawerController, context: Context) {
        // Reassign rootViews so observed-state changes in the hosted SwiftUI
        // subtrees propagate (HistorySidePanel ← HistoryModel, chat ← SdkStore).
        context.coordinator.contentHost?.rootView = content()
        context.coordinator.drawerHost?.rootView = drawer()

        // Sync the binding → controller. notify=false on close avoids the
        // controller calling back into the binding mid-sync (re-entrancy loop).
        guard isOpen != controller.isOpen else { return }
        if isOpen {
            controller.open(animated: true)
        } else {
            controller.close(animated: true, notify: false)
        }
    }

    @MainActor
    final class Coordinator {
        @Binding var isOpen: Bool
        let onOpen: () -> Void
        var contentHost: UIHostingController<Content>?
        var drawerHost: UIHostingController<Drawer>?

        init(isOpen: Binding<Bool>, onOpen: @escaping () -> Void) {
            self._isOpen = isOpen
            self.onOpen = onOpen
        }

        /// Drawer settled fully open (any path). Keep the binding in sync (a
        /// drag-open without a binding toggle) and fire the host's refresh hook.
        func handleOpened() {
            if !isOpen { isOpen = true }
            onOpen()
        }

        /// Drawer dismissed interactively (drag/tap). Clear the binding so the
        /// SwiftUI source of truth tracks the UIKit state.
        func handleDismissed() {
            if isOpen { isOpen = false }
        }
    }
}
