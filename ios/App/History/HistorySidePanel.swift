// ---------------------------------------------------------------------------
// HistorySidePanel — left panel content (design .m-hx). Owns no transport;
// reads HistoryViewModel passed in by the host (the host holds it via @StateObject,
// same as HistorySheet). Presentation and gesture wiring (Task 8.2) are
// separate; this file is content only.
//
// Layout: account header → search pill → "Past chats" title → session list
// → terra "+" FAB overlay (bottom-trailing). Mirrors the Android HistoryDrawer
// + webui sessions drawer.
//
// accessibilityIdentifiers: settings-open (HistoryAccountHeader),
// history-search, history-new-chat (FAB).
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

private let fabSize: CGFloat = 52
private let fabCorner: CGFloat = 16

enum HistorySurfaceLayout {
    static let searchMinimumHeight = DesignMetrics.minimumTarget
    static let searchTextRole: DesignTextRole = .body
}

struct HistorySidePanel: View {
    /// The host (Task 8.2 parent view) owns the model via @StateObject and
    /// passes it here. @ObservedObject is correct: the panel is a consumer, not
    /// the lifecycle owner.
    @ObservedObject var model: HistoryViewModel
    /// One stable clock per panel presentation so relative dates don't drift.
    let nowMs: Int64
    let userName: String
    let household: String
    let activeSessionId: String?
    let onSelect: (String) -> Void
    let onNewChat: () -> Void
    let onSettings: () -> Void
    /// Context-menu handlers wired by the host so Rename/Delete are functional.
    let onAskRename: (SessionRow) -> Void
    let onAskDelete: (SessionRow) -> Void

    /// True when the load failed and there are NO rows to fall back on — the
    /// list area is replaced by the SessionsErrorEmpty affordance. Guarded on
    /// `!loading` so the in-flight spinner case isn't pre-empted by a stale error.
    private var showsErrorEmpty: Bool {
        model.error != nil && model.visible.isEmpty && !model.loading
    }

    /// True when saved rows remain visible during a refresh or after that
    /// refresh fails. `loading` and `error` are the existing HistoryViewModel
    /// signals; the panel does not create a second freshness owner.
    private var showsStaleBanner: Bool {
        !model.visible.isEmpty && (model.error != nil || model.loading)
    }

    /// Spinner while the first load is still pending (the open slide + initial
    /// fetch, before `hasLoaded` latches) OR a refresh is in flight with nothing
    /// cached. Once loaded, a genuinely empty history or a filtered-empty search
    /// shows the (empty) list, never a perpetual spinner.
    private var showsLoadingSpinner: Bool {
        (model.loading || !model.hasLoaded) && model.visible.isEmpty && !showsErrorEmpty
    }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            VStack(spacing: 0) {
                HistoryAccountHeader(
                    name: userName,
                    household: household,
                    onSettings: onSettings
                )
                searchField
                pastChatsTitle
                if showsStaleBanner {
                    SessionsStaleBanner(
                        onRetry: { Task { await model.refresh() } },
                        checking: model.loading
                    )
                    .padding(.horizontal, Space.md)
                    .padding(.bottom, Space.xs)
                }
                if showsErrorEmpty {
                    SessionsErrorEmpty(onRetry: { Task { await model.refresh() } })
                    Spacer(minLength: 0)
                } else if showsLoadingSpinner {
                    historyLoadingSpinner
                    Spacer(minLength: 0)
                } else if model.visible.isEmpty {
                    historyEmptyState
                    Spacer(minLength: 0)
                } else {
                    sessionList
                }
            }
            fab
        }
        .background(DuskColors.bg)
    }

    // ── Search pill ──────────────────────────────────────────────────────────

    private var searchField: some View {
        DesignSearchField(
            prompt: "Search past chats",
            query: $model.query,
            accessibilityId: "history-search",
            onClear: model.query.isEmpty ? nil : { model.query = "" },
            textFont: Typo.ui(HistorySurfaceLayout.searchTextRole.baseSize),
            leadingPadding: Space.lg,
            trailingPadding: Space.lg,
            title: "Search past chats",
            showsTitle: false,
            showsSearchIcon: true
        )
        .autocorrectionDisabled()
        .textInputAutocapitalization(.never)
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.sm)
    }

    // ── Section title ────────────────────────────────────────────────────────

    private var pastChatsTitle: some View {
        Text("Past chats")
            .font(Typo.display(19, .medium))
            .foregroundStyle(DuskColors.ink)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Space.md)
            .padding(.bottom, Space.xs)
    }

    // ── Session list ─────────────────────────────────────────────────────────

    private var sessionList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Space.xs) {
                ForEach(model.visible, id: \.sessionId) { row in
                    HistoryRow(
                        row: row,
                        nowMs: nowMs,
                        isSelected: row.sessionId == activeSessionId,
                        onSwitch: { onSelect(row.sessionId) },
                        onAskRename: { onAskRename(row) },
                        onAskDelete: { onAskDelete(row) }
                    )
                }
            }
            .padding(.horizontal, Space.md)
            // Bottom padding ensures content is not occluded by the FAB.
            .padding(.bottom, fabSize + Space.lg * 2)
        }
    }

    @ViewBuilder
    private var historyEmptyState: some View {
        if model.isSearching {
            HistorySearchNoMatchState()
                .accessibilityIdentifier("history-no-match")
        } else {
            ContentUnavailableView {
                Label("No past chats", systemImage: "bubble.left.and.bubble.right")
            } description: {
                Text("Start a new chat to see it here.")
            }
            .accessibilityIdentifier("history-empty")
        }
    }

    // ── History loading spinner ───────────────────────────────────────────────

    private var historyLoadingSpinner: some View {
        ProgressView()
            .tint(DuskColors.accent)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.top, Space.xl)
            .accessibilityIdentifier("history-loading")
    }

    // ── New-chat FAB ─────────────────────────────────────────────────────────

    private var fab: some View {
        Button(action: onNewChat) {
            Image(systemName: "plus")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(DuskColors.ink)
                .frame(width: fabSize, height: fabSize)
        }
        .buttonStyle(HistoryFABButtonStyle())
        .padding(Space.lg)
        .accessibilityLabel("New chat")
        .accessibilityIdentifier("history-new-chat")
    }
}

/// The History FAB keeps its established 52pt face and 16pt corner while the
/// shared Canvas kernel supplies the raised material and native press response.
private struct HistoryFABButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.isFocused) private var focused

    func makeBody(configuration: Configuration) -> some View {
        let projection = DesignRaisedButtonKernelProjection.make(
            isEnabled: isEnabled,
            isPressed: configuration.isPressed,
            isFocused: focused,
            isHovered: false,
            increasedContrast: contrast == .increased,
            reduceMotion: reduceMotion
        )

        configuration.label
            .background {
                DesignCanvasKernel(
                    shape: .roundedRectangle(cornerRadius: fabCorner),
                    role: .action,
                    state: projection.state,
                    increasedContrast: projection.increasedContrast,
                    reduceMotion: projection.reduceMotion
                )
            }
            .offset(y: projection.yOffset)
            .animation(
                DesignCanvasKernel.transitionAnimation(for: .press, reduceMotion: reduceMotion),
                value: projection.state.isPressed
            )
            .contentShape(Rectangle())
    }
}

/// Product-owned no-match state for the searchable History panel. It stays
/// separate from the genuine empty-history branch so loading, error, and
/// new-chat behavior remain unchanged.
struct HistorySearchNoMatchState: View {
    var body: some View {
        HStack(alignment: .center, spacing: HistoryNoMatchLayout.contentGap) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: HistoryNoMatchLayout.iconSize, weight: .regular))
                .foregroundStyle(DuskColors.ink3)
                .frame(width: HistoryNoMatchLayout.markSize, height: HistoryNoMatchLayout.markSize)
                .background {
                    DesignCanvasWellKernel(
                        shape: .circle,
                        state: .rest
                    )
                }
                .clipShape(Circle())
            .frame(width: HistoryNoMatchLayout.markSlotSize, height: HistoryNoMatchLayout.markSlotSize)
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 0) {
                Text("No matching chats")
                    .font(Typo.ui(HistoryNoMatchLayout.titleSize, .semibold))
                    .foregroundStyle(DuskColors.ink)
                Text("Try another search.")
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(HistoryNoMatchLayout.contentPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .designWell(cornerRadius: Radii.sm)
        .padding(.horizontal, HistoryNoMatchLayout.outerMargin)
        .padding(.bottom, HistoryNoMatchLayout.outerMargin)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("No matching chats")
        .accessibilityValue("Try another search.")
    }
}

private enum HistoryNoMatchLayout {
    static let contentGap: CGFloat = 12
    static let contentPadding: CGFloat = 12
    static let outerMargin: CGFloat = 14
    static let markSize: CGFloat = 34
    static let markSlotSize: CGFloat = 38
    static let iconSize: CGFloat = 20
    static let titleSize: CGFloat = 14
}

// ---------------------------------------------------------------------------
// Preview — a wrapper view holds the @StateObject lifetime so the model is
// alive when HistorySidePanel renders it via @ObservedObject.
// ---------------------------------------------------------------------------
#if DEBUG
private let previewNowMs = Int64(Date().timeIntervalSince1970 * 1000)
private let previewDay   = Int64(86_400_000)

private func makePreviewRows() -> [SessionRow] {
    let now = previewNowMs
    let day = previewDay
    let t1 = now - 3_600_000
    let t2a = now - day
    let t2 = t2a - 7_200_000
    let t3 = now - 3 * day
    let t4 = now - 10 * day
    let r1 = SessionRow(sessionId: "s1", rootId: nil, title: "Morning briefing",
                        startedAt: t1, lastActiveAt: t1, messageCount: 12, isActive: true)
    let r2 = SessionRow(sessionId: "s2", rootId: nil, title: "Trip to Kyoto planning",
                        startedAt: t2, lastActiveAt: t2, messageCount: 8, isActive: false)
    let r3 = SessionRow(sessionId: "s3", rootId: nil, title: "Recipe ideas for dinner",
                        startedAt: t3, lastActiveAt: t3, messageCount: 5, isActive: false)
    let r4 = SessionRow(sessionId: "s4", rootId: nil, title: "Book recommendations",
                        startedAt: t4, lastActiveAt: t4, messageCount: 21, isActive: false)
    return [r1, r2, r3, r4]
}
private let previewRows = makePreviewRows()

/// Holds @StateObject lifetime; seeds sessions (or an error state); renders the
/// panel. `errorMessage != nil` drives the sessions-error / stale-banner states.
private struct PanelPreviewHost: View {
    // Preview uses a stub component (never connects — seeding happens in onAppear).
    @StateObject private var model = HistoryViewModel(
        component: createUserSession(gatewayWsUrl: "ws://localhost/api/v1/ws",
                                     allowSelfSignedDevHost: true,
                                     authenticatedUserId: "preview-user",
                                     capabilities: [],
                                     devFaultsEnabled: true, onLoggedOut: {}).component
    )
    let seed: [SessionRow]
    var errorMessage: String? = nil

    var body: some View {
        HistorySidePanel(
            model: model,
            nowMs: previewNowMs,
            userName: "Kevin",
            household: "Ye Family",
            activeSessionId: "s1",
            onSelect: { _ in },
            onNewChat: {},
            onSettings: {},
            onAskRename: { _ in },
            onAskDelete: { _ in }
        )
        .onAppear {
            if let errorMessage {
                model.seedErrorForPreview(errorMessage, rows: seed)
            } else {
                model.seedForPreview(seed)
            }
        }
    }
}

#Preview("Side panel — seeded sessions") {
    PanelPreviewHost(seed: previewRows)
        .frame(width: 320)
        .preferredColorScheme(.dark)
}

#Preview("Side panel — empty") {
    PanelPreviewHost(seed: [])
        .frame(width: 320)
        .preferredColorScheme(.dark)
}

#Preview("Side panel — load error (empty)") {
    PanelPreviewHost(seed: [], errorMessage: "network unreachable")
        .frame(width: 320)
        .preferredColorScheme(.dark)
}

#Preview("Side panel — stale banner (rows + error)") {
    PanelPreviewHost(seed: previewRows, errorMessage: "network unreachable")
        .frame(width: 320)
        .preferredColorScheme(.dark)
}
#endif
