// ---------------------------------------------------------------------------
// HistorySidePanel — left panel content (design .m-hx). Owns no transport;
// reads HistoryModel passed in by the host (the host holds it via @StateObject,
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
import MobileSdk

/// Dark-terra text used on the terra-50/accent background surfaces (avatar
/// initial + FAB icon). Sourced from HistoryAccountHeader.swift where the
/// constant is declared at module scope; aliased here to stay DRY.
private let fabIconColor = terraOnAccentText

private let fabSize: CGFloat = 52
private let fabCorner: CGFloat = 16

struct HistorySidePanel: View {
    /// The host (Task 8.2 parent view) owns the model via @StateObject and
    /// passes it here. @ObservedObject is correct: the panel is a consumer, not
    /// the lifecycle owner.
    @ObservedObject var model: HistoryModel
    /// One stable clock per panel presentation so relative dates don't drift.
    let nowMs: Int64
    let userName: String
    let household: String
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

    /// True when a re-fetch failed but rows are still loaded — a thin stale
    /// banner sits above the (stale) list. Mirrors drawer.tsx showStaleErrorBanner.
    private var showsStaleBanner: Bool {
        model.error != nil && !model.visible.isEmpty
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
                    SessionsStaleBanner(onRetry: { Task { await model.refresh() } })
                }
                if showsErrorEmpty {
                    SessionsErrorEmpty(onRetry: { Task { await model.refresh() } })
                    Spacer(minLength: 0)
                } else if model.loading && model.visible.isEmpty {
                    historyLoadingSpinner
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
        HStack(spacing: Space.sm) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(DuskColors.ink3)
            TextField("Search past chats", text: $model.query)
                .font(Typo.ui(14))
                .foregroundStyle(DuskColors.ink)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .accessibilityIdentifier("history-search")
        }
        .padding(.horizontal, Space.lg)
        .frame(height: 40)
        .background(DuskColors.bgElev, in: Capsule())
        .overlay(Capsule().stroke(DuskColors.lineSoft, lineWidth: 1))
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
                .foregroundStyle(fabIconColor)
                .frame(width: fabSize, height: fabSize)
                .background(
                    DuskColors.accent,
                    in: RoundedRectangle(cornerRadius: fabCorner)
                )
                .shadow(color: .black.opacity(0.4), radius: 10, y: 6)
        }
        .buttonStyle(.plain)
        .padding(Space.lg)
        .accessibilityIdentifier("history-new-chat")
    }
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
    @StateObject private var model = HistoryModel(store: SdkStore())
    let seed: [SessionRow]
    var errorMessage: String? = nil

    var body: some View {
        HistorySidePanel(
            model: model,
            nowMs: previewNowMs,
            userName: "Kevin",
            household: "Ye Family",
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
