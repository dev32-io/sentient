// ---------------------------------------------------------------------------
// SdkConfig — immutable orchestrator configuration.
//
// Mirrors web-sdk's SentientSDKConfig (connector-types.ts): the gateway URL,
// the dev-only self-signed bypass, the capability set advertised in
// session.configure, and the reconnect tunables. Defaults live here, not in
// code branches, per .claude/rules/config.md.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.transport.ReconnectConfig

/**
 * Configuration for [SentientSdk].
 *
 * @param gatewayWsUrl Full WS URL, e.g. `wss://host/api/v1/ws`. SessionResume
 *   appends `?session_id=` to this on connect when a stored pointer exists.
 * @param allowSelfSignedDevHost Debug-only TLS bypass. MUST be false in release.
 * @param capabilities Capability strings advertised in `session.configure`.
 *   Mirror the webui set; the orchestrator merges these with each connector's
 *   own `capability` so the gateway activates the right connectors.
 * @param reconnect Reconnect / backoff tunables (defaults mirror web-sdk).
 */
data class SdkConfig(
    val gatewayWsUrl: String,
    val allowSelfSignedDevHost: Boolean,
    val capabilities: List<String>,
    val reconnect: ReconnectConfig = ReconnectConfig(),
)
