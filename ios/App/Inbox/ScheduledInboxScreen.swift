import MobileData
import SwiftUI
import UIKit

struct ScheduledInboxClearAllIntent {
    enum Reason: Equatable { case initial, retry }
    private(set) var reason: Reason?
    var isPresented: Bool { reason != nil }

    mutating func request(_ reason: Reason, canClear: Bool) { self.reason = canClear ? reason : nil }
    mutating func cancel() { reason = nil }
}

/// Product-state aliases retained for focused gesture tests; visual recipe
/// ownership lives in the shared Design foundation.
enum ScheduledInboxSwipeMetrics {
    static var revealDistance: CGFloat { DesignMetrics.notificationCardRevealDistance }
    static var snapDistance: CGFloat { DesignMetrics.notificationCardSnapDistance }
    static var intentDistance: CGFloat { DesignMetrics.notificationCardIntentDistance }
    static var armFraction: CGFloat { DesignMetrics.notificationCardArmFraction }
}

struct ScheduledInboxSwipeState: Equatable {
    enum Intent: Equatable { case idle, undecided, horizontal, vertical }
    enum Outcome: Equatable { case unchanged, close, reveal, clear }

    private(set) var intent: Intent = .idle
    private(set) var distance: CGFloat = 0
    private var initialDistance: CGFloat = 0

    mutating func update(
        translation: CGSize,
        initialDistance: CGFloat,
        width: CGFloat,
        layoutDirection: LayoutDirection
    ) {
        guard width > 0, intent != .vertical else { return }
        if intent == .idle {
            intent = .undecided
            self.initialDistance = initialDistance
            distance = initialDistance
        }

        let trailingTravel = translation.width * (layoutDirection == .leftToRight ? -1 : 1)
        if intent == .undecided {
            if abs(translation.height) > ScheduledInboxSwipeMetrics.intentDistance,
               abs(translation.height) > abs(trailingTravel) {
                intent = .vertical
                distance = self.initialDistance
                return
            }
            guard abs(trailingTravel) >= ScheduledInboxSwipeMetrics.intentDistance else { return }
            intent = .horizontal
        }
        distance = min(max(self.initialDistance + trailingTravel, 0), width)
    }

    var isDraggingHorizontally: Bool { intent == .horizontal }

    func isArmed(width: CGFloat) -> Bool {
        width > 0 && distance >= width * ScheduledInboxSwipeMetrics.armFraction
    }

    mutating func finish(width: CGFloat) -> Outcome {
        guard intent == .horizontal else {
            reset()
            return .unchanged
        }
        let outcome: Outcome = if isArmed(width: width) {
            .clear
        } else if distance >= ScheduledInboxSwipeMetrics.snapDistance {
            .reveal
        } else {
            .close
        }
        reset()
        return outcome
    }

    mutating func cancel() -> Bool {
        let wasRevealed = initialDistance > 0
        reset()
        return wasRevealed
    }

    mutating func reset() {
        intent = .idle
        initialDistance = 0
        distance = 0
    }
}

struct ScheduledInboxScreen: View {
    @State private var vm: ScheduledMessagesViewModel
    @State private var clearAllIntent = ScheduledInboxClearAllIntent()
    @State private var openCardID: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let isOpening: Bool
    let onBack: () -> Void
    let onSelectSession: (String) -> Void

    init(
        viewModel: ScheduledMessagesViewModel,
        isOpening: Bool,
        onBack: @escaping () -> Void,
        onSelectSession: @escaping (String) -> Void
    ) {
        _vm = State(initialValue: viewModel)
        self.isOpening = isOpening
        self.onBack = onBack
        self.onSelectSession = onSelectSession
    }

    var body: some View {
        VStack(spacing: 0) {
            DesignPageHeader(title: "Messages", backAccessibilityId: "scheduled-inbox-back", onBack: onBack) {
                DesignActionButton(
                    title: "Clear all",
                    role: .destructive,
                    state: canClearAll ? .normal : .disabled,
                    accessibilityId: "scheduled-inbox-clear-all",
                    fillsWidth: false
                ) {
                    clearAllIntent.request(.initial, canClear: canClearAll)
                }
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Space.lg) {
                    notices
                    cards
                }
                .padding(.horizontal, Space.lg)
                .padding(.vertical, Space.md)
                .animation(
                    DesignV2.Motion.animation(duration: Motion.normal, reduceMotion: reduceMotion),
                    value: cardIDs
                )
            }
        }
        .background(DuskColors.bg)
        .navigationTitle("Messages")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .navigationBar)
        .nativeInteractiveBackNavigation(isEnabled: true)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("scheduled-inbox-screen")
        .duskTheme()
        .confirmationDialog(
            "Clear all messages?",
            isPresented: Binding(
                get: { clearAllIntent.isPresented },
                set: { if !$0 { clearAllIntent.cancel() } }
            ),
            titleVisibility: .visible
        ) {
            Button("Clear all", role: .destructive) {
                clearAllIntent.cancel()
                openCardID = nil
                vm.clearAll()
            }
            Button("Cancel", role: .cancel) { clearAllIntent.cancel() }
        } message: {
            Text("This clears scheduled messages from this inbox. Chats, messages, and schedules are preserved.")
        }
        .task { vm.startObservingCards() }
        .onChange(of: cardIDs) { _, ids in
            if let openCardID, !ids.contains(openCardID) { self.openCardID = nil }
        }
    }

    @ViewBuilder
    private var notices: some View {
        if let failure = vm.clearFailure {
            VStack(alignment: .leading, spacing: Space.sm) {
                AsyncNotice(
                    kind: .error,
                    title: failure.title,
                    detail: failure.detail,
                    retry: retryClear,
                    accessibilityId: "scheduled-inbox-clear-error",
                    actionTitle: vm.clearRetryRequiresConfirmation ? "Clear all again" : "Retry clear"
                )
                DesignActionButton(
                    title: "Reload",
                    role: .secondary,
                    state: busy ? .disabled : .normal,
                    accessibilityId: "scheduled-inbox-reload-after-clear",
                    action: { Task { await vm.reloadCards() } }
                )
            }
        }

        if case .failed(let message) = vm.cardsState, vm.clearFailure == nil {
            AsyncNotice(
                kind: .error,
                title: vm.cards.isEmpty ? "Messages unavailable" : "Messages may be out of date",
                detail: message,
                retry: { Task { await vm.reloadCards() } },
                actionTitle: "Reload"
            )
        }
    }

    @ViewBuilder
    private var cards: some View {
        if vm.cards.isEmpty {
            if case .ready = vm.cardsState {
                Text("All clear.")
                    .designText(.title)
                    .foregroundStyle(DuskColors.ink)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Space.xxxl)
            }
        } else {
            ForEach(vm.cards, id: \.occurrenceId) { card in
                ScheduledInboxSwipeRow(
                    card: card,
                    isRevealed: openCardID == card.occurrenceId,
                    disabled: busy,
                    onBeginSwipe: { openCardID = card.occurrenceId },
                    onSetRevealed: { revealed in
                        openCardID = revealed ? card.occurrenceId : nil
                    },
                    onClear: { vm.clear(card) },
                    onOpen: { onSelectSession(card.sessionId) }
                )
                .transition(.asymmetric(
                    insertion: .move(edge: .top).combined(with: .opacity),
                    removal: .move(edge: .leading).combined(with: .opacity)
                ))
            }
        }
    }

    private func retryClear() {
        if vm.clearRetryRequiresConfirmation {
            clearAllIntent.request(.retry, canClear: !busy)
        } else {
            vm.retryClear()
        }
    }

    private var cardIDs: [String] { vm.cards.map(\.occurrenceId) }
    private var busy: Bool { isOpening }
    private var canClearAll: Bool { !busy && !vm.cards.isEmpty }
}

private struct ScheduledInboxSwipeRow: View {
    let card: ScheduledSessionCard
    let isRevealed: Bool
    let disabled: Bool
    let onBeginSwipe: () -> Void
    let onSetRevealed: (Bool) -> Void
    let onClear: () -> Void
    let onOpen: () -> Void

    @State private var swipe = ScheduledInboxSwipeState()
    @State private var width: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.layoutDirection) private var layoutDirection

    var body: some View {
        cardFace
            .offset(x: layoutDirection == .leftToRight ? -displayedDistance : displayedDistance)
            .animation(
                swipe.isDraggingHorizontally ? nil : DesignV2.Motion.animation(duration: Motion.normal, reduceMotion: reduceMotion),
                value: displayedDistance
            )
            // Modifier order keeps tray fixed while translated face retains full row geometry.
            .background { tray }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            .gesture(dragGesture)
            .accessibilityActions {
                if !disabled {
                    Button("Clear", action: commitAndClear)
                    Button(isRevealed ? "Hide Clear" : "Reveal Clear") { onSetRevealed(!isRevealed) }
                }
            }
            .onChange(of: disabled) { wasDisabled, isDisabled in
                if wasDisabled && !isDisabled { swipe.reset() }
            }
    }

    private var tray: some View {
        DesignNotificationActionTray(
            title: armed ? "Release to clear" : "Clear",
            showsIcon: !armed,
            isVisible: displayedDistance > 0,
            isEnabled: !disabled && isRevealed,
            accessibilityLabel: "Clear notification",
            accessibilityId: "scheduled-card-clear-\(card.occurrenceId)",
            action: commitAndClear
        )
    }

    private var cardFace: some View {
        DesignNotificationCardButton(
            accessibilityLabel: "\(preview), \(completedLabel)",
            accessibilityHint: isRevealed ? "Closes clear action" : "Opens chat",
            accessibilityId: "scheduled-card-\(card.occurrenceId)",
            state: disabled ? .disabled : .normal,
            action: {
                if isRevealed { onSetRevealed(false) }
                else { onOpen() }
            }
        ) {
            VStack(alignment: .leading, spacing: Space.sm) {
                Text(completedLabel)
                    .designText(.caption)
                    .foregroundStyle(DuskColors.ink2)
                Text(preview)
                    .designText(.body)
                    .foregroundStyle(DuskColors.ink)
            }
            .padding(Space.lg)
        }
    }

    private var dragGesture: ScheduledInboxPanGesture {
        ScheduledInboxPanGesture(isEnabled: !disabled) { translation in
            let wasHorizontal = swipe.isDraggingHorizontally
            swipe.update(
                translation: translation,
                initialDistance: isRevealed ? ScheduledInboxSwipeMetrics.revealDistance : 0,
                width: width,
                layoutDirection: layoutDirection
            )
            if !wasHorizontal && swipe.isDraggingHorizontally { onBeginSwipe() }
        } onEnd: { cancelled in
            if cancelled {
                onSetRevealed(swipe.cancel())
                return
            }
            switch swipe.finish(width: width) {
            case .unchanged: break
            case .close: onSetRevealed(false)
            case .reveal: onSetRevealed(true)
            case .clear: commitAndClear()
            }
        }
    }

    private func commitAndClear() {
        guard !disabled, width > 0 else { return }
        // Row removal owns the exit transition; a fast failed clear may reuse this row.
        swipe.reset()
        onClear()
    }

    private var displayedDistance: CGFloat {
        if swipe.intent != .idle || swipe.distance > 0 { return swipe.distance }
        return isRevealed ? min(ScheduledInboxSwipeMetrics.revealDistance, width) : 0
    }

    private var armed: Bool { swipe.isArmed(width: width) }

    private var preview: String {
        if let preview = card.preview { return String(preview.prefix(280)) }
        return card.status == .failed ? "Scheduled conversation failed" : "Scheduled conversation interrupted"
    }

    private var completedLabel: String {
        let date = (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(card.completedAt))
            ?? (try? Date.ISO8601FormatStyle().parse(card.completedAt))
        return date?.formatted(date: .abbreviated, time: .shortened) ?? card.completedAt
    }
}

/// Like the drawer's pan bridge: reject vertical travel before recognition so
/// ScrollView keeps scrolling. Unlike a simultaneous SwiftUI DragGesture, this
/// recognizer cancels the card Button's touch instead of also firing its action.
private struct ScheduledInboxPanGesture: UIGestureRecognizerRepresentable {
    let isEnabled: Bool
    let onChange: (CGSize) -> Void
    let onEnd: (Bool) -> Void

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let pan = UIPanGestureRecognizer()
        pan.delegate = context.coordinator
        pan.isEnabled = isEnabled
        return pan
    }

    func updateUIGestureRecognizer(_ pan: UIPanGestureRecognizer, context: Context) {
        pan.isEnabled = isEnabled
    }

    func handleUIGestureRecognizerAction(_ pan: UIPanGestureRecognizer, context: Context) {
        // Window coordinates stay fixed while the card face moves.
        let translation = pan.translation(in: nil)
        switch pan.state {
        case .began, .changed, .ended:
            onChange(CGSize(width: translation.x, height: translation.y))
            if pan.state == .ended { onEnd(false) }
        case .cancelled:
            onEnd(true)
        default:
            break
        }
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return false }
            let travel = pan.translation(in: nil)
            return abs(travel.x) > abs(travel.y)
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool {
            other is UIPanGestureRecognizer
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldBeRequiredToFailBy other: UIGestureRecognizer
        ) -> Bool {
            other is UIPanGestureRecognizer
        }
    }
}
