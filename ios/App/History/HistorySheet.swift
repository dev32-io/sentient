// ---------------------------------------------------------------------------
// HistorySheet — the iOS History sheet (D-I4). A native SwiftUI `.sheet`
// (replaces the webui 360px CSS drawer / Android ModalNavigationDrawer) holding
// the session history. Content mirrors the Android HistoryDrawer + webui sessions
// drawer:
//   - a search field (history-search) that filters the list client-side
//   - the session list from store.listSessions (title + relative time + message
//     count; active session highlighted via SessionRow.isActive), grouped by
//     date bucket (Today / Yesterday / Last 7 days / Older)
//   - tap a row → store.switchSession + dismiss; context menu → rename/delete
//   - a New Chat button (history-new-chat) → store.newChat + dismiss
//
// Reconnect-safe refresh: the list re-queries on every present AND after every
// mutation (HistoryModel re-calls listSessions in each op). The SDK does not
// surface onSessionsChanged through SentientSdk, so present + post-mutation
// re-query is the refresh path (D-A4/D-I4 plan fallback).
//
// accessibilityIdentifiers: history-search, history-row-<sessionId>,
// history-new-chat. The history-open trigger lives in the ChatView title bar.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

private let emptyDefault = "No past chats yet."
private let emptyLoadFail = "Couldn't load sessions — try again."

/// A row pending a rename/delete confirmation (.sheet alert payload).
private struct PendingTarget: Identifiable {
    let id: String
    let title: String
}

struct HistorySheet: View {
    /// The sheet owns its list/search state holder, built over the single app
    /// SdkStore passed by the host. @StateObject keeps it alive across the sheet's
    /// recompositions; the model re-queries listSessions on present + each mutation.
    @StateObject private var model: HistoryModel
    /// One stable clock per present pass so the date labels don't drift mid-scroll.
    let nowMs: Int64
    let onDismiss: () -> Void

    @State private var renaming: PendingTarget?
    @State private var deleting: PendingTarget?
    @State private var renameText = ""

    init(store: SdkStore, nowMs: Int64, onDismiss: @escaping () -> Void) {
        _model = StateObject(wrappedValue: HistoryModel(store: store))
        self.nowMs = nowMs
        self.onDismiss = onDismiss
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: Space.sm) {
                searchField
                sessionListBody
                newChatButton
            }
            .padding(.horizontal, Space.md)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(DuskColors.bg)
            .navigationTitle("Past chats")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done", action: onDismiss)
                }
            }
        }
        .task { await model.refresh() }
        .renamePrompt($renaming, text: $renameText) { id, title in
            Task { await model.renameSession(id, title: title) }
        }
        .deletePrompt($deleting) { id in
            Task { await model.deleteSession(id) }
        }
        .duskTheme()
    }

    // ── Search ────────────────────────────────────────────────────────────────

    private var searchField: some View {
        TextField("Search past chats", text: $model.query)
            .textFieldStyle(.roundedBorder)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .accessibilityIdentifier("history-search")
            .padding(.top, Space.sm)
    }

    // ── Session list ────────────────────────────────────────────────────────────

    @ViewBuilder
    private var sessionListBody: some View {
        let rows = model.visible
        if rows.isEmpty {
            emptyState
        } else {
            List {
                ForEach(groupByDate(rows, nowMs: nowMs)) { group in
                    Section(header: groupHeader(group.label)) {
                        ForEach(group.rows, id: \.sessionId) { row in
                            HistoryRow(
                                row: row,
                                nowMs: nowMs,
                                onSwitch: { switchTo(row.sessionId) },
                                onAskRename: { askRename(row) },
                                onAskDelete: { askDelete(row) }
                            )
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets())
                            .swipeActions(edge: .trailing) {
                                Button("Delete", role: .destructive) { askDelete(row) }
                                Button("Rename") { askRename(row) }.tint(DuskColors.accent)
                            }
                        }
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        let msg: String = {
            if model.loading { return "Loading…" }
            if model.error != nil { return emptyLoadFail }
            if model.isSearching { return "No matches for \"\(model.query.trimmingCharacters(in: .whitespaces))\"" }
            return emptyDefault
        }()
        VStack {
            Spacer()
            Text(msg).font(.system(size: TypeScale.sm)).foregroundStyle(DuskColors.ink3)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func groupHeader(_ label: String) -> some View {
        Text(label)
            .font(.system(size: TypeScale.xs, weight: .semibold))
            .foregroundStyle(DuskColors.ink3)
    }

    // ── New chat ──────────────────────────────────────────────────────────────

    private var newChatButton: some View {
        Button {
            Task {
                await model.newChat()
                onDismiss()
            }
        } label: {
            Text("New Chat")
                .font(.system(size: TypeScale.base, weight: .semibold))
                .foregroundStyle(DuskColors.bg)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Space.sm)
                .background(DuskColors.accent, in: RoundedRectangle(cornerRadius: Radii.md))
        }
        .buttonStyle(.plain)
        .padding(.bottom, Space.md)
        .accessibilityIdentifier("history-new-chat")
    }

    // ── Actions ───────────────────────────────────────────────────────────────

    private func switchTo(_ sessionId: String) {
        Task {
            await model.switchSession(sessionId)
            onDismiss()
        }
    }

    private func askRename(_ row: SessionRow) {
        renameText = row.title
        renaming = PendingTarget(id: row.sessionId, title: row.title)
    }

    private func askDelete(_ row: SessionRow) {
        deleting = PendingTarget(id: row.sessionId, title: row.title)
    }
}

// ── Date grouping ───────────────────────────────────────────────────────────
//
// Group by date bucket (Today / Yesterday / Last 7 days / Older), mirroring the
// Android groupByDate + webui session-list.tsx. Rows arrive lastActiveAt-
// descending from the gateway, so a single forward pass keeps buckets ordered.

private struct DateGroup: Identifiable {
    let label: String
    let rows: [SessionRow]
    var id: String { label }
}

private func groupByDate(_ rows: [SessionRow], nowMs: Int64) -> [DateGroup] {
    var out: [DateGroup] = []
    var current: [SessionRow] = []
    var label = ""
    for row in rows {
        let bucket = RelativeTime.dateGroupLabel(nowMs: nowMs, lastActiveMs: row.lastActiveAt)
        if current.isEmpty || bucket != label {
            if !current.isEmpty { out.append(DateGroup(label: label, rows: current)) }
            current = [row]
            label = bucket
        } else {
            current.append(row)
        }
    }
    if !current.isEmpty { out.append(DateGroup(label: label, rows: current)) }
    return out
}

// ── Rename / delete prompts ───────────────────────────────────────────────────
//
// Native alerts (mirrors the Android AlertDialog rename/delete). Extracted as
// view modifiers so the body stays flat. The rename alert uses an inline
// TextField (iOS 16+ alert text-field API); delete is a destructive confirm.

private extension View {
    func renamePrompt(
        _ target: Binding<PendingTarget?>,
        text: Binding<String>,
        onConfirm: @escaping (String, String) -> Void
    ) -> some View {
        alert("Rename chat", isPresented: Binding(
            get: { target.wrappedValue != nil },
            set: { if !$0 { target.wrappedValue = nil } }
        )) {
            TextField("Title", text: text)
                .accessibilityIdentifier("history-rename-input")
            Button("Save") {
                if let t = target.wrappedValue {
                    let trimmed = text.wrappedValue.trimmingCharacters(in: .whitespaces)
                    if !trimmed.isEmpty { onConfirm(t.id, trimmed) }
                }
                target.wrappedValue = nil
            }
            Button("Cancel", role: .cancel) { target.wrappedValue = nil }
        }
    }

    func deletePrompt(
        _ target: Binding<PendingTarget?>,
        onConfirm: @escaping (String) -> Void
    ) -> some View {
        alert("Delete chat?", isPresented: Binding(
            get: { target.wrappedValue != nil },
            set: { if !$0 { target.wrappedValue = nil } }
        ), presenting: target.wrappedValue) { t in
            Button("Delete", role: .destructive) {
                onConfirm(t.id)
                target.wrappedValue = nil
            }
            Button("Cancel", role: .cancel) { target.wrappedValue = nil }
        } message: { t in
            Text("\"\(t.title)\" will be permanently deleted.")
        }
    }
}
