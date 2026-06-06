// ---------------------------------------------------------------------------
// BackendSetupView — "Sentient backend". Host + Port + 3-way security Picker +
// a Save button that probes then dismisses on success, or shows an error.
// accessibilityIdentifiers: backend-host, backend-port, backend-security,
// backend-save, backend-error.
// ---------------------------------------------------------------------------
import SwiftUI

struct BackendSetupView: View {
    @StateObject var model: BackendSetupModel
    var onSaved: () -> Void

    // Surfaces the iOS Local Network permission prompt on appear, so it's
    // resolved BEFORE the user taps Save & connect (the first LAN connection).
    @State private var lanPrimer = LocalNetworkPrimer()

    var body: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            Text("Sentient backend")
                .font(.system(size: TypeScale.lg, weight: .semibold))
                .foregroundStyle(DuskColors.ink)
            Text("Point the app at your Sentient gateway.")
                .font(.system(size: TypeScale.base))
                .foregroundStyle(DuskColors.ink3)

            TextField("Host or IP", text: $model.host)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .accessibilityIdentifier("backend-host")
            TextField("Port", text: $model.port)
                .keyboardType(.numberPad)
                .accessibilityIdentifier("backend-port")

            Picker("Security", selection: $model.security) {
                Text("TLS").tag(ConnectionSecurity.tlsValid)
                Text("TLS · self-signed").tag(ConnectionSecurity.tlsTrustSelfSigned)
                Text("Plain ws").tag(ConnectionSecurity.plainWs)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("backend-security")

            if model.security == .tlsTrustSelfSigned {
                Text("Trusts a self-signed certificate for this server only. Use for LAN/self-hosted gateways.")
                    .font(.system(size: TypeScale.xs))
                    .foregroundStyle(DuskColors.ink3)
            }
            if let error = model.error {
                Text(error)
                    .foregroundStyle(DuskColors.stop)
                    .accessibilityIdentifier("backend-error")
            }

            Button(action: model.save) {
                Group {
                    if model.isSaving {
                        ProgressView()
                    } else if model.didSave {
                        Text("✓")
                    } else {
                        Text("Save & connect")
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, Space.sm)
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.isSaving)
            .accessibilityIdentifier("backend-save")

            Spacer()
        }
        .padding(Space.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(DuskColors.bg)
        .duskTheme()
        .onChange(of: model.didSave) { _, saved in if saved { onSaved() } }
        .task { lanPrimer.start() }
        .onDisappear { lanPrimer.cancel() }
    }
}

#Preview("Empty") {
    BackendSetupView(
        model: BackendSetupModel(existing: nil, reconfigure: { _ in }),
        onSaved: {}
    )
}

#Preview("Pre-filled") {
    BackendSetupView(
        model: BackendSetupModel(
            existing: BackendConfig(host: "192.168.1.42", port: 8888, security: .tlsTrustSelfSigned),
            reconfigure: { _ in }
        ),
        onSaved: {}
    )
}
