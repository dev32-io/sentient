import SwiftUI

struct BackendSetupView: View {
    @StateObject var model: BackendSetupViewModel
    var onSaved: () -> Void

    @State private var lanPrimer = LocalNetworkPrimer()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        DesignPageChrome(title: "Sentient backend", accessibilityId: "backend-setup", showsBack: false) {
            AsyncNotice(
                kind: .warning,
                title: "Local Network access",
                detail: "Allow access when iOS asks so Sentient can verify a gateway on your network."
            )

            DesignPane(title: "Connection", detail: "Point the app at your Sentient gateway.") {
                DesignField(
                    title: "Host or IP",
                    prompt: "gateway.example.com",
                    text: $model.host,
                    error: model.error == "Enter a host or IP." ? model.error : nil,
                    accessibilityId: "backend-host"
                )
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)

                DesignField(
                    title: "Port",
                    prompt: "443",
                    text: $model.port,
                    error: model.error == "Port must be 1–65535." ? model.error : nil,
                    accessibilityId: "backend-port"
                )
                .keyboardType(.numberPad)

                DesignSegmentedPicker(
                    title: "Security",
                    options: [
                        (.tlsValid, "TLS"),
                        (.tlsTrustSelfSigned, "Self-signed"),
                        (.plainWs, "Plain ws"),
                    ],
                    selection: $model.security
                )
                .accessibilityIdentifier("backend-security")

                if model.security == .tlsTrustSelfSigned {
                    AsyncNotice(
                        kind: .warning,
                        title: "Self-signed certificate",
                        detail: "Trust applies only to this server. Use it only for a gateway you control."
                    )
                }
            }

            if let error = model.error {
                AsyncNotice(kind: .error, title: "Couldn't connect", detail: error, retry: model.save)
                    .accessibilityIdentifier("backend-error")
            } else if model.didSave {
                AsyncNotice(kind: .success, title: "Backend saved")
            }

            DesignActionButton(
                title: "Save & connect",
                state: model.isSaving ? .loading : .normal,
                accessibilityId: "backend-save",
                action: model.save
            )
        }
        .animation(DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: reduceMotion), value: model.didSave)
        .onChange(of: model.didSave) { _, saved in if saved { onSaved() } }
        .task { lanPrimer.start() }
        .onDisappear { lanPrimer.cancel() }
    }
}

#Preview("Empty — large text") {
    BackendSetupView(
        model: BackendSetupViewModel(existing: nil, reconfigure: { _ in }, probe: { _ in false }, retryDelay: .zero),
        onSaved: {}
    )
    .environment(\.dynamicTypeSize, .accessibility3)
}

#Preview("Pre-filled") {
    BackendSetupView(
        model: BackendSetupViewModel(
            existing: BackendConfig(host: "192.168.1.42", port: 443, security: .tlsTrustSelfSigned),
            reconfigure: { _ in },
            probe: { _ in true }
        ),
        onSaved: {}
    )
}
