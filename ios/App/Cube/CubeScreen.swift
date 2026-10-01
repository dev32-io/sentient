import SwiftUI

/// Typed leaves share the account's hardware owner; navigation is never BLE ownership.
enum CubePage: Hashable {
    case devices, setup, manual, hub, wifi, details, access, recovery

    var title: String {
        switch self {
        case .devices: "Cubes"
        case .setup: "Set up Cube"
        case .manual: "Pairing info"
        case .hub: "Cube"
        case .wifi: "Wi-Fi"
        case .details: "Device details"
        case .access: "Manage access"
        case .recovery: "Restore phone access"
        }
    }
}

struct CubeScreen: View {
    let model: CubeViewModel?
    let page: CubePage
    let onBack: () -> Void
    let onOpen: (CubePage) -> Void
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var locator = ""
    @State private var pairingCode = ""
    @State private var scanning = false
    @State private var openManualAfterScan = false
    @State private var payload: CubeSetupPayload?
    @State private var confirmSetup = false
    @State private var confirmDisable = false
    @State private var confirmReenroll = false
    @State private var ssid = ""
    @State private var password = ""

    init(model: CubeViewModel?, page: CubePage = .devices, onBack: @escaping () -> Void,
         onOpen: @escaping (CubePage) -> Void = { _ in }) {
        self.model = model
        self.page = page
        self.onBack = onBack
        self.onOpen = onOpen
    }

#if DEBUG
    // Synthetic presentation input only. No transport or proof-validation bypass.
    init(model: CubeViewModel?, page: CubePage, fixturePairingCode: String = "",
         fixtureSSID: String = "", fixturePassword: String = "") {
        self.init(model: model, page: page, onBack: {})
        _pairingCode = State(initialValue: fixturePairingCode)
        _ssid = State(initialValue: fixtureSSID)
        _password = State(initialValue: fixturePassword)
    }
#endif

    var body: some View {
        Group {
            if let model, page == .setup || page == .devices {
                entry(model)
            } else {
                DesignPageChrome(title: page.title, accessibilityId: "cube-screen", onBack: onBack) {
                    if let model {
                        content(model)
                    } else {
                        AsyncNotice(kind: .error, title: "Cube setup unavailable", detail: "Configure a supported secure gateway and sign in again.")
                    }
                }
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .task {
            guard !Task.isCancelled else { return }
            if page == .hub, scenePhase == .active { model?.enterHub() }
            if page == .devices || (page == .recovery && model?.selected == nil) { model?.refreshRegistry() }
            if page == .manual { model?.discoverPairingCubes() }
#if DEBUG
            if page == .devices, ProcessInfo.processInfo.arguments.contains("--qa-cube-setup"),
               ProcessInfo.processInfo.environment["CUBE_SMOKE_QR"] != nil { scanning = true }
            if page == .wifi { fillDebugWifi() }
#endif
        }
        .onChange(of: model?.selected) { _, selected in
            if selected != nil, page == .manual {
                clearSecrets()
                onOpen(.hub)
            }
        }
#if DEBUG
        .onChange(of: model?.pairingLocators) { _, names in
            guard page == .manual, ProcessInfo.processInfo.arguments.contains("--qa-cube-setup"),
                  let text = ProcessInfo.processInfo.environment["CUBE_QA_MANUAL_JSON"],
                  let input = try? CubeSetupPayload.parse(text), names?.contains(input.name) == true else { return }
            locator = input.name
            pairingCode = input.pop
        }
#endif
        // Covering a page must not stop enrollment or Wi-Fi. The stack owner handles leaving Cube.
        .onDisappear { clearSecrets() }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { model?.pause(); clearSecrets() }
            else if page == .hub { model?.enterHub() }
            if phase == .background { openManualAfterScan = false; scanning = false }
        }
        .sheet(isPresented: $scanning, onDismiss: {
            if openManualAfterScan {
                openManualAfterScan = false
                onOpen(.manual)
            } else { confirmSetup = payload != nil }
        }) {
            CubeScannerScreen(onBack: { scanning = false }, onScanned: { value in
                payload = value
                scanning = false
            }, onManual: {
                openManualAfterScan = true
                scanning = false
            })
        }
        .alert("Connect Cube to your account?", isPresented: $confirmSetup) {
            Button("Connect Cube") {
                if page == .manual {
                    model?.setupManual(locator: locator, code: pairingCode)
                    pairingCode = ""
                } else if let payload {
                    model?.setup(payload)
                    onOpen(.hub)
                }
                payload = nil
            }
            Button("Cancel", role: .cancel) { payload = nil; pairingCode = "" }
        } message: {
            Text("Anyone using this Cube can speak to your agent. Keep Cube powered on and nearby.")
        }
        .alert("Disable agent access?", isPresented: $confirmDisable) {
            Button("Disable agent access", role: .destructive) { model?.disable() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Stops new agent access; retains ownership and history. Already-started external work may finish. Previous phones may retain offline Bluetooth access. This is not a factory reset or transfer.")
        }
        .alert("Re-enable this Cube?", isPresented: $confirmReenroll) {
            Button("Start new enrollment") {
                model?.reenroll()
                onOpen(.hub)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Starts a fresh owner-authorized attempt using the same Bluetooth manager secret. Keep Cube nearby. It becomes usable only after account activation and a verified Sentient connection.")
        }
    }

    /// Flexible center plus safe-area actions. Registry loading never inserts hardware controls above it.
    private func entry(_ model: CubeViewModel) -> some View {
        VStack(spacing: 0) {
            DesignPageHeader(title: page.title, onBack: onBack)
            GeometryReader { geometry in
                ScrollView {
                    VStack(spacing: Space.xl) {
                        if page == .devices, !model.deviceIds.isEmpty {
                            inventory(model)
                        } else if page == .setup || model.confirmedEmpty {
                            CubeCharacter(size: 168)
                            VStack(spacing: Space.md) {
                                Text("Set up Cube").designText(.display).accessibilityAddTraits(.isHeader)
                                Text("Power on Cube and keep it nearby.").designText(.body).foregroundStyle(DuskColors.ink2)
                            }
                        } else {
                            registryNotice(model)
                        }
                    }
                    .multilineTextAlignment(page == .devices && !model.deviceIds.isEmpty ? .leading : .center)
                    .frame(maxWidth: .infinity)
                    .padding(Space.lg)
                    .frame(minHeight: geometry.size.height,
                           alignment: page == .devices && !model.deviceIds.isEmpty ? .top : .center)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: Space.sm) {
                    if page == .setup || model.confirmedEmpty {
                        DesignActionButton(title: "Scan Cube", accessibilityId: "cube-scan", action: scan)
                        DesignActionButton(title: "Already paired?", role: .quiet, accessibilityId: "cube-already-paired") {
                            onOpen(.recovery)
                        }
                    } else if !model.deviceIds.isEmpty {
                        DesignActionButton(title: "Add Cube", accessibilityId: "cube-add") { onOpen(.setup) }
                    }
                }
                .padding(.horizontal, Space.lg).padding(.vertical, Space.md)
                .background(DuskColors.bg)
            }
        }
        .background(DuskColors.bg)
        .foregroundStyle(DuskColors.ink)
        .navigationTitle(page.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .navigationBar)
        .navigationBarBackButtonHidden(false)
        .nativeInteractiveBackNavigation(isEnabled: true)
        .accessibilityIdentifier("cube-screen")
        .duskTheme()
    }

    @ViewBuilder private func content(_ model: CubeViewModel) -> some View {
        switch page {
        case .devices:
            inventory(model)
        case .setup: EmptyView() // Full-height entry composition above.
        case .manual:
            manual(model)
            operationNotice(model)
        case .hub:
            if let id = model.selected {
                if model.needsSetup { setupProgress(model, id: id) }
                else { hub(model, id: id) }
            }
        case .wifi:
            wifi(model)
            operationNotice(model)
        case .details:
            details(model)
        case .access:
            access(model)
            operationNotice(model)
        case .recovery:
            recovery(model)
            operationNotice(model)
        }
    }

    @ViewBuilder private func registryNotice(_ model: CubeViewModel) -> some View {
        switch model.registryState {
        case .idle:
            AsyncNotice(kind: .warning, title: "Cubes not checked", detail: "Refresh to see owned Cubes and saved phone access.",
                retry: model.refreshRegistry, accessibilityId: "cube-registry-idle")
        case .loading:
            AsyncNotice(kind: .loading, title: "Loading your Cubes", accessibilityId: "cube-registry-loading")
        case .failed(let message):
            AsyncNotice(kind: .error, title: "Couldn’t load Cubes", detail: message,
                retry: model.refreshRegistry, accessibilityId: "cube-registry-error")
        case .loaded: EmptyView()
        }
    }

    private func inventory(_ model: CubeViewModel) -> some View {
        VStack(alignment: .leading, spacing: Space.md) {
            if model.deviceIds.isEmpty { registryNotice(model) }
            if !model.deviceIds.isEmpty {
                DesignCard {
                    ForEach(model.deviceIds, id: \.self) { id in
                        Button { model.select(id); onOpen(.hub) } label: {
                            inventoryRow(model, id: id)
                                .padding(.vertical, Space.sm).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("cube-device-\(id)")
                        if id != model.deviceIds.last { DesignDivider() }
                    }
                }
            }
            DesignActionButton(title: "Refresh Cubes", loadingTitle: "Refreshing Cubes", role: .quiet,
                state: model.registryState == .loading ? .loading : .normal,
                accessibilityId: "cube-registry-refresh", action: model.refreshRegistry)
                .disabled(model.busy)
            if !model.deviceIds.isEmpty, case .failed = model.registryState { registryNotice(model) }
        }
    }

    @ViewBuilder private func inventoryRow(_ model: CubeViewModel, id: String) -> some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: Space.sm) {
                HStack {
                    CubeCharacter(size: 56)
                    Spacer(minLength: Space.sm)
                    inventoryChevron
                }
                inventoryLabels(model, id: id)
            }
        } else {
            HStack(spacing: Space.md) {
                CubeCharacter(size: 56)
                inventoryLabels(model, id: id)
                inventoryChevron
            }
        }
    }

    private func inventoryLabels(_ model: CubeViewModel, id: String) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text("Cube").designText(.large).foregroundStyle(DuskColors.ink)
            Text(model.displayIdentifier(id)).designText(.caption).foregroundStyle(DuskColors.ink2)
            Text(model.inventoryLabel(id)).designText(.supporting).foregroundStyle(DuskColors.ink2)
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var inventoryChevron: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: TypeScale.xs, weight: .semibold))
            .foregroundStyle(DuskColors.ink3).accessibilityHidden(true)
    }

    private func setupProgress(_ model: CubeViewModel, id: String) -> some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            VStack(spacing: Space.sm) {
                CubeCharacter(size: 96)
                Text(model.busy ? "Connecting…" : "Finish setup")
                    .designText(.title).accessibilityAddTraits(.isHeader)
                Text(model.displayIdentifier(id)).designText(.caption).foregroundStyle(DuskColors.ink2)
            }.frame(maxWidth: .infinity)
            operationNotice(model, showsProgress: !model.connecting)
            connectionNotice(model)
            DesignActionButton(title: "Connect Wi-Fi", accessibilityId: "cube-wifi") { onOpen(.wifi) }
                .disabled(model.busy || !model.hardwareAvailable)
            if model.selectedAttempt != nil {
                DesignActionButton(title: "Resume saved setup", role: .secondary,
                    accessibilityId: "cube-resume", action: model.resumeSetup).disabled(model.busy)
            } else if model.hardwareAvailable {
                DesignActionButton(title: "Refresh setup status", role: .secondary,
                    accessibilityId: "cube-refresh", action: model.connectNearby).disabled(model.busy)
            }
            Text(model.selectedRecord?.status == "disabled"
                 ? "Agent access is disabled. Setup is not complete until account activation and a verified Sentient connection."
                 : "Keep Cube and iPhone nearby. Setup completes only after account activation and a verified Sentient connection.")
                .designText(.supporting).foregroundStyle(DuskColors.ink2)
            DesignActionButton(title: "Manage access", role: .quiet, accessibilityId: "cube-access") { onOpen(.access) }
        }
    }

    private func hub(_ model: CubeViewModel, id: String) -> some View {
        VStack(spacing: Space.lg) {
            VStack(spacing: Space.sm) {
                CubeCharacter(size: 96)
                Text("Cube").designText(.title).accessibilityAddTraits(.isHeader)
                Text(model.displayIdentifier(id)).designText(.caption).foregroundStyle(DuskColors.ink2)
                HStack(spacing: Space.sm) {
                    if model.connecting {
                        ProgressView().controlSize(.small).accessibilityHidden(true)
                    } else {
                        Circle().fill(model.status?.ready == true && model.nearby && model.selectedRecord?.status != "disabled" ? DuskColors.sage : DuskColors.amber)
                            .frame(width: Space.sm, height: Space.sm).accessibilityHidden(true)
                    }
                    Text(hubSummary(model)).designText(.supporting)
                }.foregroundStyle(DuskColors.ink2)
            }.frame(maxWidth: .infinity)
            connectionNotice(model)
            DesignCard {
                valueRow("Battery", value: !model.hardwareAvailable ? "Unavailable" : model.status?.batteryPercent.map { "\($0)%\(model.status?.charging == true ? " · charging" : "")" } ?? "Not reported", available: model.hardwareAvailable)
                DesignDivider()
                linkRow("Wi-Fi", detail: wifiSummary(model), id: "cube-wifi") { onOpen(.wifi) }
                    .privacySensitive()
                    .disabled(model.busy || !model.hardwareAvailable)
                    .opacity(model.hardwareAvailable ? 1 : 0.5)
                DesignDivider()
                valueRow("Bluetooth", value: model.hardwareAvailable ? "Connected" : "Not connected")
                DesignDivider()
                valueRow("Sentient", value: model.selectedRecord?.status == "disabled" ? "Disabled" : !model.hardwareAvailable ? "Unavailable" : model.status.map { $0.gatewayConnected ? "Connected at last check" : "Offline at last check" } ?? "Unavailable", available: model.hardwareAvailable)
                DesignDivider()
                linkRow("Device details", id: "cube-details") { onOpen(.details) }
            }
            HStack(spacing: Space.md) {
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text(model.checkedAt == nil ? "Hardware not checked" : "Last checked").designText(.caption)
                    if let checkedAt = model.checkedAt {
                        Text(checkedAt, format: .dateTime.month().day().hour().minute().second()).designText(.caption)
                    }
                }.foregroundStyle(DuskColors.ink2)
                Spacer(minLength: 0)
                DesignIconButton(systemName: "arrow.clockwise", label: "Refresh hardware status", accessibilityId: "cube-refresh", action: model.connectNearby)
                    .disabled(model.busy)
            }
            DesignActionButton(title: "Manage access", role: .quiet, accessibilityId: "cube-access") { onOpen(.access) }
            if model.status?.accountAttention == true {
                AsyncNotice(kind: .warning, title: "Account needs attention", detail: "Check ownership or disable before re-enrolling.")
            }
            // Nearby authentication already lives in the hero. Explicit Wi-Fi work
            // and authenticated setup completion still retain their own feedback.
            operationNotice(model, showsProgress: !model.connecting && (model.busy || model.hardwareAvailable))
        }
    }

    private func manual(_ model: CubeViewModel) -> some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            Text("Choose the nearby locator shown beneath Cube’s QR code, then enter all 43 characters. Spaces between groups are ignored; case and punctuation matter.")
                .designText(.body).foregroundStyle(DuskColors.ink2)
            DesignCard(bodyStyle: .padded) {
                VStack(alignment: .leading, spacing: Space.md) {
                    Picker("Nearby Cube", selection: $locator) {
                        Text("Choose Cube").tag("")
                        ForEach(model.pairingLocators, id: \.self) { Text($0).tag($0) }
                    }.tint(DuskColors.accent).accessibilityIdentifier("cube-manual-locator")
                    DesignSecureField(title: "Pairing code", text: $pairingCode)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive()
                        .accessibilityIdentifier("cube-manual-code")
                }
            }
            DesignActionButton(title: "Connect Cube", accessibilityId: "cube-manual-connect") { confirmSetup = true }
                .disabled(model.busy || locator.isEmpty || (try? CubeSetupPayload.manualSecret(pairingCode)) == nil)
            DesignActionButton(title: "Search again", role: .quiet) { locator = ""; model.discoverPairingCubes() }.disabled(model.busy)
            bluetoothSettings
        }
    }

    private func wifi(_ model: CubeViewModel) -> some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            Text("2.4 GHz networks only. Keep Cube powered on and nearby.").designText(.body).foregroundStyle(DuskColors.ink2)
            connectionNotice(model)
            DesignCard(bodyStyle: .padded) {
                VStack(alignment: .leading, spacing: Space.md) {
                    DesignField(title: "Network name", text: $ssid)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("cube-wifi-ssid")
                    DesignSecureField(title: "Wi-Fi password", text: $password).privacySensitive()
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("cube-wifi-password")
                    Text("Password goes directly to Cube, never to your profile.").designText(.supporting).foregroundStyle(DuskColors.ink2)
                }
            }.disabled(model.busy || !model.hardwareAvailable)
                .opacity(model.hardwareAvailable ? 1 : 0.5)
            DesignActionButton(title: "Send Wi-Fi settings", accessibilityId: "cube-wifi-send") {
                let value = password
                password = ""
                model.setWifi(ssid: ssid, password: value)
            }.disabled(model.busy || !model.hardwareAvailable || (try? CubeControl.wifi(ssid: ssid, password: password)) == nil)
            DesignActionButton(title: "Check connection / retry", role: .secondary, action: model.checkUntilReady)
                .disabled(model.busy || !model.hardwareAvailable)
            Text("Wi-Fi changes do not reset ownership or re-enable disabled agent access.").designText(.supporting).foregroundStyle(DuskColors.ink2)
        }
    }

    private func details(_ model: CubeViewModel) -> some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            DesignCard {
                valueRow("Model", value: "Sentient Cube")
                DesignDivider()
                DesignSettingsRow(title: "Device") {
                    if let id = model.selected {
                        HStack(spacing: Space.sm) {
                            Text(model.displayIdentifier(id)).designText(.supporting)
                                .foregroundStyle(DuskColors.ink2)
                                .lineLimit(1).truncationMode(.middle)
                                .accessibilityLabel("Device identifier")
                                .accessibilityValue(id)
                            DesignIconButton(systemName: "doc.on.doc", label: "Copy full device identifier",
                                accessibilityId: "cube-copy-device-id") { UIPasteboard.general.string = id }
                        }
                    } else {
                        Text("Not selected").designText(.supporting)
                    }
                }
                DesignDivider()
                valueRow("Firmware", value: model.hardwareAvailable ? model.status?.firmware ?? "Not reported" : "Unavailable", available: model.hardwareAvailable)
                DesignDivider()
                valueRow("Enrollment", value: model.hardwareAvailable ? model.status?.phase ?? "Not reported" : "Unavailable", available: model.hardwareAvailable)
                DesignDivider()
                valueRow("Account", value: model.selectedRecord?.status ?? "Not checked")
            }
        }
    }

    private func access(_ model: CubeViewModel) -> some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            DesignCard {
                linkRow("Restore phone access", detail: "For a replacement phone. Internet required.", id: "cube-recovery") { onOpen(.recovery) }
            }
            AsyncNotice(kind: .warning, title: "Agent access", detail: "Disabling stops new agent access. Ownership and history remain. Already-started external work may finish. Previous phones may retain offline Bluetooth access. This is not a factory reset or transfer.")
            if model.selectedRecord?.status == "disabled" {
                DesignActionButton(title: "Re-enable with new enrollment") { confirmReenroll = true }.disabled(model.busy)
            } else {
                DesignActionButton(title: "Disable agent access", role: .destructive, accessibilityId: "cube-disable") { confirmDisable = true }.disabled(model.busy)
            }
        }
    }

    @ViewBuilder private func recovery(_ model: CubeViewModel) -> some View {
        Text("Use the same owning account to manage Cube on a replacement phone. Internet required.")
            .designText(.body).foregroundStyle(DuskColors.ink2)
        if model.selected == nil {
            inventory(model)
            if model.confirmedEmpty {
                AsyncNotice(kind: .warning, title: "No Cubes on this account", detail: "Sign in with the account that owns Cube. Scanning a paired Cube does not transfer ownership.")
            }
        } else {
            AsyncNotice(kind: .warning, title: "Phone access only", detail: "Recovery does not re-enable a disabled Cube. Previous phones may retain offline Bluetooth access.")
            DesignActionButton(title: "Restore phone access", accessibilityId: "cube-recover", action: model.recover).disabled(model.busy)
            DesignActionButton(title: "Connect nearby", role: .secondary, accessibilityId: "cube-connect", action: model.connectNearby).disabled(model.busy)
            bluetoothSettings
        }
    }

    @ViewBuilder private func connectionNotice(_ model: CubeViewModel) -> some View {
        if !model.hardwareAvailable, !model.busy {
            if model.needsPhoneAccess {
                AsyncNotice(kind: .warning, title: "Restore phone access",
                    detail: "This phone has no saved access for Cube. Restore access with the owning account, then retry Bluetooth. Bluetooth permission alone does not grant access.")
                DesignActionButton(title: "Restore phone access", role: .secondary,
                    accessibilityId: "cube-recovery") { onOpen(.recovery) }
            }
            DesignActionButton(title: "Retry connection", role: .secondary,
                accessibilityId: "cube-connect", action: model.connectNearby)
        }
    }

    @ViewBuilder private func operationNotice(_ model: CubeViewModel, showsProgress: Bool = true) -> some View {
        if let message = model.message {
            AsyncNotice(kind: .error, title: "Couldn’t finish", detail: message, accessibilityId: "cube-error")
            bluetoothSettings
        }
        if showsProgress, !model.progress.isEmpty {
            VStack(alignment: .leading, spacing: Space.md) {
                Text(model.progress).designText(.body).foregroundStyle(DuskColors.ink2).accessibilityIdentifier("cube-progress")
                if model.busy {
                    ProgressView("Keep Cube and iPhone nearby")
                    DesignActionButton(title: "Pause", role: .quiet, accessibilityId: "cube-pause", action: model.pause)
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(Space.md).designPlate()
        }
    }

    private var bluetoothSettings: some View {
        DesignActionButton(title: "Bluetooth settings", role: .quiet) {
            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
        }
    }

    private func valueRow(_ title: String, value: String, available: Bool = true) -> some View {
        DesignSettingsRow(title: title) {
            Text(value).designText(.supporting).foregroundStyle(DuskColors.ink2)
                .multilineTextAlignment(.trailing).textSelection(.enabled)
        }.opacity(available ? 1 : 0.5)
    }

    private func linkRow(_ title: String, detail: String? = nil, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            DesignSettingsRow(title: title, detail: detail) {
                Image(systemName: "chevron.right").foregroundStyle(DuskColors.ink3).accessibilityHidden(true)
            }.contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier(id)
    }

    private func hubSummary(_ model: CubeViewModel) -> String {
        if model.connecting { return "Connecting nearby…" }
        if model.needsPhoneAccess { return "Restore phone access" }
        if model.selectedRecord?.status == "disabled" { return "Agent access disabled" }
        guard model.nearby, let status = model.status else { return "Not connected nearby" }
        if status.accountAttention { return "Account needs attention" }
        if status.ready { return "Connected at last check" }
        if !status.wifiConnected { return "Wi-Fi \(status.wifiState)" }
        return "Sentient not ready"
    }

    private func wifiSummary(_ model: CubeViewModel) -> String {
        guard model.hardwareAvailable, let status = model.status else { return "Unavailable · connect nearby" }
        return (status.ssid.isEmpty ? status.wifiState : "\(status.ssid) · \(status.wifiState)") + " · last checked"
    }

    private func scan() { model?.pause(); pairingCode = ""; scanning = true }
    private func clearSecrets() { password = ""; pairingCode = ""; payload = nil; confirmSetup = false }

#if DEBUG
    private func fillDebugWifi() {
        // Fill only; the real button retains validation and encrypted delivery.
        guard ProcessInfo.processInfo.arguments.contains("--qa-cube-setup"),
              let raw = ProcessInfo.processInfo.environment["CUBE_QA_WIFI_JSON"],
              let fields = try? JSONDecoder().decode([String: String].self, from: Data(raw.utf8)),
              let network = fields["ssid"], let secret = fields["password"],
              (try? CubeControl.wifi(ssid: network, password: secret)) != nil else { return }
        ssid = network
        password = secret
    }
#endif
}

private struct CubeCharacter: View {
    let size: CGFloat
    var body: some View {
        Image("CubeCompanion").resizable().interpolation(.none).scaledToFit()
            .padding(size * 0.08)
            .frame(width: size, height: size)
            .background(DuskColors.bgSunk, in: RoundedRectangle(cornerRadius: Radii.xl))
            .overlay { RoundedRectangle(cornerRadius: Radii.xl).strokeBorder(DuskColors.line, lineWidth: 4) }
            .accessibilityHidden(true)
    }
}
