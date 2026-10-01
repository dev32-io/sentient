#if DEBUG
import MobileData
import SwiftUI

/// Launch actual setup/hub without mounting chats, profiles, push or diagnostic upload.
/// Existing owner bearer still faces the real registry's authentication/ownership checks.
@MainActor
struct CubePhysicalSetup: View {
    @State private var path: [CubePage] = []
    @State private var model: CubeViewModel?
    @State private var requirement = "Checking Cube setup prerequisites"

    var body: some View {
        NavigationStack(path: $path) {
            if let model {
                CubeScreen(model: model, onBack: { model.pause() }, onOpen: openPage)
                    .navigationDestination(for: CubePage.self) { page in
                        CubeScreen(model: model, page: page, onBack: { if !path.isEmpty { path.removeLast() } },
                            onOpen: openPage)
                    }
            } else {
                Text(requirement).padding().accessibilityIdentifier("cube-setup-requirement")
            }
        }
        .onChange(of: path) { old, new in
            model?.navigationChanged(from: old.last ?? .devices, to: new.last ?? .devices)
        }
        .onDisappear { model?.pause() }
        .task { await prepare() }
    }

    private func openPage(_ page: CubePage) {
        if page == .hub { path.removeAll() }
        path.append(page)
    }

    private func prepare() async {
        let environment = ProcessInfo.processInfo.environment
        if environment["CUBE_QA_LOGIN_JSON"] != nil {
            await login(environment: environment)
            return
        }
        let tokens = createTokenStore()
        guard let account = AuthenticatedIdentityStore().load(), tokens.load() != nil else {
            report("Owner sign-in required in Sentient Debug. No stored owner credentials changed.")
            return
        }
        let resolved = resolveBackend(override: BackendConfigStore().load(),
            buildTimeDefaultURL: GatewayConfig.buildTimeDefaultWsURL,
            buildTimeAllowSelfSigned: GatewayConfig.buildTimeAllowSelfSigned)
        guard case let .configured(url, trust) = resolved,
              let gateway = try? CubeGateway(wsURL: url) else {
            report("Supported HTTPS gateway configuration required in Sentient Debug.")
            return
        }
        // Operator supplies the approved LOCAL origin, never an alternate token or auth bypass.
        guard ProcessInfo.processInfo.environment["CUBE_QA_LOCAL_ORIGIN"] == gateway.origin.absoluteString else {
            report("Existing owner credentials present. Confirm configured gateway is approved LOCAL origin before registry access.")
            return
        }
        do {
            let store = try CubeManagerStore(gatewayOrigin: gateway.origin, accountId: account)
            model = CubeViewModel(registry: CubeRegistry(gateway: gateway,
                allowSelfSignedDevHost: trust, token: { tokens.load() }), store: store, ble: CubeBLESession())
            print("CUBE_SETUP actual-setup-screen-mounted")
        } catch { report("Cube Keychain scope unavailable. Unlock phone and retry.") }
    }

    private func login(environment: [String: String]) async {
        do {
            let login = try CubeLocalLogin.parse(environment: environment)
            let gateway = try CubeGateway(wsURL: login.gatewayWsURL)
            let client = createAuthClient(gatewayWsUrl: login.gatewayWsURL,
                                          allowSelfSignedDevHost: login.allowSelfSigned)
            let result = try await client.login(userId: login.userId, pin: login.pin)
            try Task.checkCancellation()
            guard case let .success(success) = onEnum(of: result),
                  let response = success.value, !response.token.isEmpty,
                  response.user.userId == login.userId else {
                report("Local test login rejected.")
                return
            }
            // Dedicated test bearer stays memory-only; never replace saved personal auth.
            let bearer = response.token
            let store = try CubeManagerStore(gatewayOrigin: gateway.origin, accountId: response.user.userId)
            model = CubeViewModel(registry: CubeRegistry(gateway: gateway,
                allowSelfSignedDevHost: login.allowSelfSigned, token: { bearer }),
                store: store, ble: CubeBLESession())
            print("CUBE_SETUP actual-setup-screen-mounted")
        } catch is CancellationError {
            return
        } catch {
            report("Local test login unavailable or configuration rejected.")
        }
    }

    private func report(_ value: String) {
        requirement = value
        print("CUBE_SETUP \(value)")
    }
}
/// Credentials arrive through private launch environment, never launch arguments or app resources.
struct CubeLocalLogin: Decodable {
    let gatewayWsURL: String
    let userId: String
    let pin: String
    let allowSelfSigned: Bool

    static func parse(environment: [String: String]) throws -> Self {
        guard let raw = environment["CUBE_QA_LOGIN_JSON"], raw.utf8.count <= 4096 else {
            throw CubeHardwareError.authentication
        }
        let value = try JSONDecoder().decode(Self.self, from: Data(raw.utf8))
        let gateway = try CubeGateway(wsURL: value.gatewayWsURL)
        guard environment["CUBE_QA_LOCAL_ORIGIN"] == gateway.origin.absoluteString,
              !value.userId.isEmpty, value.pin.count == 4,
              value.pin.allSatisfy({ "0123456789".contains($0) }) else {
            throw CubeHardwareError.authentication
        }
        return value
    }
}
#endif
