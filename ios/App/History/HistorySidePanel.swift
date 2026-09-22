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

enum HistoryListPresentation: Equatable {
    case loading, error, empty, content, staleContent
}

func historyListPresentation(
    rowCount: Int,
    loading: Bool,
    hasLoaded: Bool,
    hasError: Bool
) -> HistoryListPresentation {
    if rowCount > 0 { return hasError ? .staleContent : .content }
    if hasError && !loading { return .error }
    if loading || !hasLoaded { return .loading }
    return .empty
}

func historyEntryIsSelected(
    _ row: HistoryEntry,
    activeSessionId: String?,
    activeDraftId: String?
) -> Bool {
    (row.sessionId != nil && row.sessionId == activeSessionId)
        || (row.draftId != nil && row.draftId == activeDraftId)
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
    let activeDraftId: String?
    let onSelect: (HistoryEntry) -> Void
    let onNewChat: () -> Void
    let onSettings: () -> Void
    /// Context-menu handlers wired by the host so Rename/Delete are functional.
    let onAskRename: (HistoryEntry) -> Void
    let onAskDelete: (HistoryEntry) -> Void
    let onAskDiscard: (HistoryEntry) -> Void

    var body: some View {
        HistorySidePanelContent(
            rows: model.visible,
            query: $model.query,
            loading: model.loading,
            hasLoaded: model.hasLoaded,
            hasError: model.error != nil,
            isSearching: model.isSearching,
            nowMs: nowMs,
            userName: userName,
            household: household,
            activeSessionId: activeSessionId,
            activeDraftId: activeDraftId,
            hasPermanentDeleteFailure: model.hasPermanentDeleteFailure,
            onSelect: onSelect,
            onNewChat: onNewChat,
            onSettings: onSettings,
            onRetry: { Task { await model.refresh() } },
            onRetryDeletes: { Task { await model.retryDeletes() } },
            onAskRename: onAskRename,
            onAskDelete: onAskDelete,
            onAskDiscard: onAskDiscard
        )
    }
}

/// Stateless production composition shared by the ViewModel adapter and debug fixtures.
struct HistorySidePanelContent: View {
    let rows: [HistoryEntry]
    @Binding var query: String
    let loading: Bool
    let hasLoaded: Bool
    let hasError: Bool
    let isSearching: Bool
    let nowMs: Int64
    let userName: String
    let household: String
    let activeSessionId: String?
    let activeDraftId: String?
    let hasPermanentDeleteFailure: Bool
    let onSelect: (HistoryEntry) -> Void
    let onNewChat: () -> Void
    let onSettings: () -> Void
    let onRetry: () -> Void
    let onRetryDeletes: () -> Void
    let onAskRename: (HistoryEntry) -> Void
    let onAskDelete: (HistoryEntry) -> Void
    let onAskDiscard: (HistoryEntry) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(
        rows: [HistoryEntry], query: Binding<String>, loading: Bool, hasLoaded: Bool,
        hasError: Bool, isSearching: Bool, nowMs: Int64, userName: String,
        household: String, activeSessionId: String?, activeDraftId: String?,
        hasPermanentDeleteFailure: Bool, onSelect: @escaping (HistoryEntry) -> Void,
        onNewChat: @escaping () -> Void, onSettings: @escaping () -> Void,
        onRetry: @escaping () -> Void, onRetryDeletes: @escaping () -> Void,
        onAskRename: @escaping (HistoryEntry) -> Void,
        onAskDelete: @escaping (HistoryEntry) -> Void,
        onAskDiscard: @escaping (HistoryEntry) -> Void
    ) {
        self.rows = rows; _query = query; self.loading = loading; self.hasLoaded = hasLoaded
        self.hasError = hasError; self.isSearching = isSearching; self.nowMs = nowMs
        self.userName = userName; self.household = household; self.activeSessionId = activeSessionId
        self.activeDraftId = activeDraftId; self.hasPermanentDeleteFailure = hasPermanentDeleteFailure
        self.onSelect = onSelect; self.onNewChat = onNewChat; self.onSettings = onSettings
        self.onRetry = onRetry; self.onRetryDeletes = onRetryDeletes
        self.onAskRename = onAskRename; self.onAskDelete = onAskDelete; self.onAskDiscard = onAskDiscard
    }

    /// Compatibility initializer for existing visual fixtures.
    init(
        rows: [SessionRow], query: Binding<String>, loading: Bool, hasLoaded: Bool,
        hasError: Bool, isSearching: Bool, nowMs: Int64, userName: String,
        household: String, activeSessionId: String?, onSelect: @escaping (String) -> Void,
        onNewChat: @escaping () -> Void, onSettings: @escaping () -> Void,
        onRetry: @escaping () -> Void, onAskRename: @escaping (SessionRow) -> Void,
        onAskDelete: @escaping (SessionRow) -> Void
    ) {
        let byId = Dictionary(uniqueKeysWithValues: rows.map { ($0.sessionId, $0) })
        self.init(
            rows: rows.map { HistoryEntry(kind: .session(id: $0.sessionId, draftId: nil), title: $0.title, lastActiveAt: $0.lastActiveAt, hasDraft: false) },
            query: query, loading: loading, hasLoaded: hasLoaded, hasError: hasError,
            isSearching: isSearching, nowMs: nowMs, userName: userName, household: household,
            activeSessionId: activeSessionId, activeDraftId: nil, hasPermanentDeleteFailure: false,
            onSelect: { if let id = $0.sessionId { onSelect(id) } }, onNewChat: onNewChat,
            onSettings: onSettings, onRetry: onRetry, onRetryDeletes: {},
            onAskRename: { if let id = $0.sessionId, let row = byId[id] { onAskRename(row) } },
            onAskDelete: { if let id = $0.sessionId, let row = byId[id] { onAskDelete(row) } },
            onAskDiscard: { _ in }
        )
    }

    private var presentation: HistoryListPresentation {
        historyListPresentation(
            rowCount: rows.count,
            loading: loading,
            hasLoaded: hasLoaded,
            hasError: hasError
        )
    }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            VStack(spacing: 0) {
                HistoryAccountHeader(name: userName, household: household, onSettings: onSettings)
                searchField
                pastChatsTitle
                if hasPermanentDeleteFailure {
                    SessionsDeleteFailureBanner(onRetry: onRetryDeletes)
                        .padding(.horizontal, Space.md)
                        .padding(.bottom, Space.xs)
                } else if presentation == .staleContent {
                    SessionsStaleBanner(onRetry: onRetry)
                        .padding(.horizontal, Space.md)
                        .padding(.bottom, Space.xs)
                }
                switch presentation {
                case .error:
                    SessionsErrorEmpty(onRetry: onRetry)
                    Spacer(minLength: 0)
                case .loading:
                    historyLoadingSpinner
                    Spacer(minLength: 0)
                case .empty:
                    historyEmptyState
                    Spacer(minLength: 0)
                case .content, .staleContent:
                    sessionList
                }
            }
            fab
        }
        .background(DuskColors.bg)
    }

    private var searchField: some View {
        DesignSearchField(
            prompt: "Search past chats",
            query: $query,
            accessibilityId: "history-search",
            onClear: query.isEmpty ? nil : { query = "" },
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

    private var pastChatsTitle: some View {
        Text("Past chats")
            .font(Typo.display(19, .medium))
            .foregroundStyle(DuskColors.ink)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Space.md)
            .padding(.bottom, Space.xs)
    }

    private var sessionList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Space.xs) {
                ForEach(rows) { row in
                    HistoryRow(
                        row: row,
                        nowMs: nowMs,
                        isSelected: historyEntryIsSelected(
                            row,
                            activeSessionId: activeSessionId,
                            activeDraftId: activeDraftId
                        ),
                        onSwitch: { onSelect(row) },
                        onAskRename: { onAskRename(row) },
                        onAskDelete: { onAskDelete(row) },
                        onAskDiscard: { onAskDiscard(row) }
                    )
                    .transition(
                        reduceMotion
                            ? .identity
                            : .asymmetric(
                                insertion: .opacity.combined(with: .move(edge: .top)),
                                removal: .identity
                            )
                    )
                }
            }
            .padding(.horizontal, Space.md)
            .padding(.bottom, fabSize + Space.lg * 2)
            .animation(
                DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: reduceMotion),
                value: rows.map(\.id)
            )
        }
    }

    @ViewBuilder private var historyEmptyState: some View {
        if isSearching {
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

    private var historyLoadingSpinner: some View {
        ProgressView()
            .tint(DuskColors.accent)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.top, Space.xl)
            .accessibilityIdentifier("history-loading")
    }

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
            activeDraftId: nil,
            onSelect: { _ in },
            onNewChat: {},
            onSettings: {},
            onAskRename: { _ in },
            onAskDelete: { _ in },
            onAskDiscard: { _ in }
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
