// Standalone real-leaf host. Excluded from ordinary app and test execution.
#if K_NATIVE_FIXTURE
import MobileData
import SwiftUI

@main final class KNativeFixtureDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "K isolated", sessionRole: session.role)
        configuration.delegateClass = KNativeFixtureSceneDelegate.self
        return configuration
    }
}

final class KNativeFixtureSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        let bounds = scene.screen.bounds
        window.frame = CGRect(x: 0, y: 0, width: ProcessInfo.processInfo.environment["K_WIDTH"] == "320" ? 320 : bounds.width, height: bounds.height)
        let host = UIHostingController(rootView: KNativeHost().duskTheme())
        if ProcessInfo.processInfo.environment["K_CONTRAST"] == "increased" { host.traitOverrides.accessibilityContrast = .high }
        window.rootViewController = host
        self.window = window
        window.makeKeyAndVisible()
    }
}

@MainActor @Observable final class KScheduleDriver {
    var draft = ScheduleDraft(message: "Disposable schedule", timeZone: "America/Los_Angeles")
    var presented = false
    var saving = false
    var error: String?
    var writes = 0
    var cancels = 0
    var dismissals = 0
    var phase = "idle"
    private var pending: CheckedContinuation<Bool, Never>?
    private var timeout: Task<Void, Never>?
    private var submitted: ScheduleDraft?
    private var submittedTiming: ScheduleTimingInput?

    init(_ mode: String) {
        switch mode {
        case "delay": draft.mode = .delay
        case "weekly": draft.mode = .recurring; draft.frequency = .weekly
        case "recurring-utc": draft.mode = .recurring; draft.timeZone = "Etc/UTC"
        case "monthly": draft.mode = .recurring; draft.frequency = .monthly; draft.dayOfMonth = 28
        default: break
        }
        let fields = ScheduleEditorFields(absolute: "", delay: "30", recurringTime: "09:00", dayOfMonth: "28", timeZone: draft.timeZone)
        if draft.mode == .recurring { _ = fields.apply(to: &draft) }
    }

    func save() async {
        // Same validation boundary as production create; no shared use cases or SDK writes.
        guard let request = draft.createRequest else { error = draft.validationMessage; return }
        writes += 1; submitted = draft; submittedTiming = request.timing; saving = true; error = nil; phase = "saving"
        let success = await withCheckedContinuation { continuation in
            pending = continuation
            // Bounded fake only. Abandoned fixture cannot leave an unbounded write pending.
            timeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(45)) } catch { return }
                self?.resolve(false, timedOut: true)
            }
        }
        saving = false
        if success { phase = "success"; presented = false }
        else { error = "Disposable save failure"; if phase != "timeout" { phase = "failure" } }
    }

    func resolve(_ success: Bool, timedOut: Bool = false) {
        guard let pending else { return }
        self.pending = nil; timeout?.cancel(); timeout = nil
        if timedOut { phase = "timeout" }
        pending.resume(returning: success)
    }
    func cancel() { guard !saving else { return }; cancels += 1; presented = false }
    var telemetry: String {
        let unchanged = submitted.map {
            $0.message == draft.message && $0.mode == draft.mode && $0.frequency == draft.frequency &&
            $0.date == draft.date && $0.localTime == draft.localTime && $0.timeZone == draft.timeZone &&
            $0.delayMinutes == draft.delayMinutes && $0.weekday == draft.weekday && $0.dayOfMonth == draft.dayOfMonth
        } ?? true
        let recurrence: String
        if let submittedTiming, case .recurring(let timing) = onEnum(of: submittedTiming) {
            recurrence = ";submittedClock=\(timing.localTime);submittedZone=\(timing.timeZone)"
        } else { recurrence = "" }
        return "writes=\(writes);cancels=\(cancels);dismissals=\(dismissals);phase=\(phase);sheet=\(presented);draftUnchanged=\(unchanged);mode=\(draft.mode.rawValue);frequency=\(draft.frequency.rawValue)" + recurrence
    }
}

@MainActor @Observable final class KCubeDriver {
    static let id = "12345678-1234-4234-8234-123456789abc"
    let registry = FakeCubeRegistry()
    let store = MemoryCubeStore()
    let ble = FakeCubeBLE(deviceId: id)
    let model: CubeViewModel
    var ready = false
    var preparationFailed = false
    var page: CubePage = .hub
    init(_ state: String) {
        model = CubeViewModel(registry: registry, store: store, ble: ble)
        registry.listed = [CubeRegistryRecord(version: 1, deviceId: Self.id,
            attemptId: "22345678-1234-4234-8234-123456789abc", generation: 1,
            deviceClass: "cube", status: state == "disabled" ? "disabled" : state == "setup" ? "pending" : "active",
            expiresAt: 1_900_000_000_000, managerSecret: nil)]
        if state != "no-phone" && state != "setup" { store.secrets[Self.id] = CubeSecret.encode(Data(repeating: 9, count: 32)) }
        ble.installed = true; ble.active = true
        if state == "unknown-battery" { ble.batteryPercent = nil }
        if state == "ownership" { ble.accountAttention = true; ble.active = false }
        if state == "offline" || state == "disabled" { ble.rejectProof = true }
        if state == "empty" || state == "manual" || state == "unavailable" {
            registry.listed = []; store.secrets = [:]
            page = state == "empty" ? .devices : .manual
            if state == "unavailable" { ble.discoveryError = .unavailable }
        }
    }
    func prepare() async {
        model.refreshRegistry()
        guard await idle() else { preparationFailed = true; return }
        if page == .hub {
            model.select(Self.id); model.enterHub()
            guard await idle() else { preparationFailed = true; return }
        }
        ready = true
    }
    private func idle() async -> Bool {
        let deadline = ContinuousClock.now + .seconds(3)
        while (model.busy || model.registryState == .loading) && ContinuousClock.now < deadline { await Task.yield() }
        return !model.busy && model.registryState != .loading
    }
    func open(_ next: CubePage) { model.navigationChanged(from: page, to: next); page = next }
    var telemetry: String {
        "ready=\(ready);preparationFailed=\(preparationFailed);registryWrites=\(registry.operations.count);hardware=\(model.hardwareAvailable);checked=\(model.checkedAt != nil);page=\(page);needsPhone=\(model.needsPhoneAccess);setup=\(model.needsSetup);bleConnections=\(ble.connections.count);bleCommands=\(ble.commands.count);savedSecrets=\(store.secrets.count);savedAttempts=\(store.saved.count)"
    }
}

@MainActor private struct KNativeHost: View {
    private let configuration = ProcessInfo.processInfo.environment
    @State private var schedule: KScheduleDriver
    @State private var cube: KCubeDriver
    private var scenario: String { configuration["K_SCENARIO"] ?? "once" }
    private var size: DynamicTypeSize { configuration["K_SIZE"] == "AX5" ? .accessibility5 : .large }
    init() {
        let state = ProcessInfo.processInfo.environment["K_SCENARIO"] ?? "once"
        _schedule = State(initialValue: KScheduleDriver(state))
        _cube = State(initialValue: KCubeDriver(state.replacingOccurrences(of: "cube-", with: "")))
    }
    var body: some View {
        NavigationStack {
            if scenario.hasPrefix("cube-") {
                if cube.ready {
                    CubeScreen(model: cube.model, page: cube.page, onBack: { cube.open(.devices) }, onOpen: cube.open)
                        .id(cube.page)
                } else { Text(cube.preparationFailed ? "Fixture preparation failed" : "Preparing fake Cube") }
            } else if scenario == "cards" {
                DesignPageChrome(title: "Scheduled messages", accessibilityId: "k-cards", showsBack: false) {
                    ForEach(Self.cards, id: \.scheduleId) { schedule in
                        ScheduleSummaryCard(schedule: schedule, disabled: true, onEdit: {}, onToggle: {}, onDelete: {})
                    }
                }
            } else {
                Button("Open schedule editor") { schedule.presented = true }
                    .accessibilityIdentifier("k-open")
                    .sheet(isPresented: Binding(get: { schedule.presented }, set: {
                        if !$0 && !schedule.saving { schedule.presented = false; schedule.dismissals += 1 }
                    })) {
                        ScheduleEditor(draft: $schedule.draft, isSaving: schedule.saving, saveError: schedule.error,
                                       onCancel: schedule.cancel, onSave: schedule.save)
                            .environment(\.dynamicTypeSize, size)
                            .overlay(alignment: .topTrailing) { probe }
                    }
            }
        }
        .environment(\.dynamicTypeSize, size)
        .overlay(alignment: .topTrailing) { probe }
        .preferredColorScheme(.dark)
        .task { if scenario.hasPrefix("cube-") { await cube.prepare() } }
    }
    private var probe: some View {
        Menu {
            Button("Fail save") { schedule.resolve(false) }
            Button("Finish save") { schedule.resolve(true) }
            Button("Hub") { cube.open(.hub) }
            Button("Wi-Fi") { cube.open(.wifi) }
            Button("Details") { cube.open(.details) }
            Button("Access") { cube.open(.access) }
            Button("Recovery") { cube.open(.recovery) }
            Button("Disconnect fake BLE") { cube.ble.onDisconnect?() }
        } label: { Image(systemName: "testtube.2").frame(width: 44, height: 44) }
        .accessibilityLabel("K fixture controls")
        .accessibilityIdentifier("k-probe")
        .accessibilityValue((scenario.hasPrefix("cube-") ? cube.telemetry : schedule.telemetry) + ";locale=\(Locale.current.identifier)")
        .padding(.trailing, 8)
    }
    private static var cards: [Schedule] {
        let states: [(ScheduleFrequency, String, Bool)] = [(.weekly, "America/Los_Angeles", true), (.monthly, "Europe/Paris", false)]
        return states.enumerated().map { index, item in
            let (frequency, zone, enabled): (ScheduleFrequency, String, Bool) = item
            return Schedule(scheduleId: "fixture-\(index)", revision: 1, message: "Disposable \(enabled ? "active" : "paused") message",
                timing: ScheduleTiming.Recurring(frequency: frequency, localTime: "09:00", timeZone: zone,
                    weekdays: frequency == .weekly ? [.monday] : nil, dayOfMonth: frequency == .monthly ? KotlinInt(int: 28) : nil),
                enabled: enabled, source: ScheduleSource.User.shared, nextRunAt: "2026-08-01T22:30:00Z",
                createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z")
        }
    }
}
#endif
