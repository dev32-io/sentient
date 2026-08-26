// ---------------------------------------------------------------------------
// MemoryViewModel — the Memory (MEMORY.md / USER.md) page state holder. SLOW
// save: PUT /profile/memory/{slot} is a restart-on-write endpoint, so
// ApplyProfileChangeUseCase.PutMemory blocks through the Hermes restart.
//
// Each slot is fetched LAZILY the first time it is viewed and holds its own
// last-saved `original`, editable `draft`, and server `charLimit`. Dirty is a
// per-slot string diff; Save puts every dirty slot (each its own FSM run) and
// refetches server truth on Ready. KMP data classes aren't Swift-Equatable, so
// only the Swift-native draft strings are compared.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

@MainActor
@Observable
final class MemoryViewModel {
    /// The two memory files, in tab order. Maps to the SDK MemorySlot on write.
    enum Slot: String, CaseIterable {
        case memory
        case user

        var sdk: MemorySlot { self == .memory ? .memory : .user }
        var label: String { self == .memory ? "Shared notes" : "About you" }
    }

    /// Per-slot editing state. `original` is nil until the slot is first fetched.
    struct SlotState {
        var loaded = false
        var original: String?
        var draft = ""
        var charLimit = 0
        var loadError: String?

        var isDirty: Bool {
            guard let original else { return false }
            return draft != original
        }
    }

    enum Save: Equatable {
        case idle
        case saving
        case restarting
        case alreadyApplying
        case applied
        case failed(String)
    }

    private(set) var memoryState = SlotState()
    private(set) var userState = SlotState()
    private(set) var save: Save = .idle

    private let settings: SettingsComponent
    private let log = AppLog("settings", "memory-vm")

    init(settings: SettingsComponent) {
        self.settings = settings
    }

    func state(for slot: Slot) -> SlotState {
        slot == .memory ? memoryState : userState
    }

    /// True when any slot has unsaved edits (the page-level dirty flag).
    var isDirty: Bool { memoryState.isDirty || userState.isDirty }
    var isApplying: Bool { save == .saving || save == .restarting }

    /// Set the current draft for `slot` (the editor's onChange).
    func setDraft(_ text: String, for slot: Slot) {
        if slot == .memory { memoryState.draft = text } else { userState.draft = text }
    }

    /// Lazily load a slot the first time it is viewed. Idempotent.
    func loadIfNeeded(_ slot: Slot) async {
        if state(for: slot).loaded { return }
        log.info("load.slot slot=\(slot.rawValue)")
        do {
            let result = try await settings.profileRepository.getMemory(slot: slot.sdk)
            switch onEnum(of: result) {
            case .success(let s):
                apply(s.data.content, charLimit: Int(s.data.charLimit), to: slot)
            case .failure(let f):
                setError(f.error.userMessage, to: slot)
                log.warn("load.slot.failed slot=\(slot.rawValue) kind=\(f.error.kind)")
            case .loading:
                break
            }
        } catch is CancellationError {
        } catch {
            setError("Couldn't load \(slot.label).", to: slot)
            log.warn("load.slot.threw slot=\(slot.rawValue)")
        }
    }

    /// Clear a failed slot and retry its lazy load.
    func retry(_ slot: Slot) async {
        if slot == .memory { memoryState = SlotState() } else { userState = SlotState() }
        await loadIfNeeded(slot)
    }

    /// Save every dirty slot, each its own FSM run; refetch truth on Ready.
    func save() async {
        let dirty = Slot.allCases.filter { state(for: $0).isDirty }
        guard !dirty.isEmpty else { return }
        log.info("save.start slots=\(dirty.map(\.rawValue).joined(separator: ","))")
        for slot in dirty where await putSlot(slot) == false { return }
        save = .applied
        log.info("save.done")
    }

    /// Run one slot's PutMemory FSM. Returns false on a terminal failure/notice.
    private func putSlot(_ slot: Slot) async -> Bool {
        let content = state(for: slot).draft
        let mutation = ProfileMutationPutMemory(slot: slot.sdk, content: content)
        for await fsm in settings.applyProfileChange.invoke(mutation: mutation) {
            switch onEnum(of: fsm) {
            case .idle: break
            case .saving: save = .saving
            case .restarting: save = .restarting
            case .ready:
                if await reload(slot) == false {
                    save = .failed("Saved, but couldn't refresh \(slot.label) — check your changes before saving again.")
                    return false
                }
            case .alreadyApplying:
                save = .alreadyApplying
                log.warn("save.already-applying slot=\(slot.rawValue)")
                return false
            case .failed(let f):
                save = .failed(f.error.userMessage)
                log.warn("save.failed slot=\(slot.rawValue)")
                return false
            }
        }
        return true
    }

    /// Refetch a slot's server truth into original + draft after a successful save.
    /// Returns false when the refetch itself failed — the save already succeeded
    /// server-side, but a dropped refetch would leave `original` stale and the
    /// slot would wrongly keep reporting dirty; the caller surfaces that instead
    /// of silently continuing.
    private func reload(_ slot: Slot) async -> Bool {
        do {
            let result = try await settings.profileRepository.getMemory(slot: slot.sdk)
            switch onEnum(of: result) {
            case .success(let s):
                apply(s.data.content, charLimit: Int(s.data.charLimit), to: slot)
                return true
            case .failure(let f):
                log.warn("reload.slot.failed slot=\(slot.rawValue) kind=\(f.error.kind)")
                return false
            case .loading:
                return true
            }
        } catch is CancellationError {
            return true
        } catch {
            log.warn("reload.slot.threw slot=\(slot.rawValue)")
            return false
        }
    }

    private func apply(_ content: String, charLimit: Int, to slot: Slot) {
        var next = SlotState()
        next.loaded = true
        next.original = content
        next.draft = content
        next.charLimit = charLimit
        if slot == .memory { memoryState = next } else { userState = next }
    }

    private func setError(_ message: String, to slot: Slot) {
        if slot == .memory {
            memoryState.loaded = true
            memoryState.loadError = message
        } else {
            userState.loaded = true
            userState.loadError = message
        }
    }
}
