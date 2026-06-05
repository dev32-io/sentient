// ---------------------------------------------------------------------------
// LoadingState — pure mapping from SDK status + pending/banner context to a
// loading-affordance case. No Android framework imports; testable with kotlin-test.
//
// Policy:
//  - SENDING   when a queued PendingSend exists (any status). Takes priority
//              because the user's send is in flight regardless of connection.
//  - CONNECTING when status is CONNECTING or AUTHENTICATING AND connectionLost is
//               false — i.e. this is the first connect, not a reconnect loop.
//               Reconnect loops are owned by ConnectionBanner (RECONNECTING case)
//               so we never double-up with a LoadingPill there.
//  - NONE      in all other cases (READY, RECONNECTING with connectionLost=true,
//              DISCONNECTED, ERROR, and the banner-owns-reconnect path).
// ---------------------------------------------------------------------------
package io.sentient.android.chat

import io.sentient.mobilesdk.transport.SdkStatus

/** Which inline loading affordance to display near the composer. */
enum class LoadingAffordance { NONE, CONNECTING, SENDING }

/**
 * Pure mapping from the single SDK state surface + pending-send flag to a
 * [LoadingAffordance].
 *
 * @param status The current [SdkStatus] from [io.sentient.mobilesdk.sdk.SdkState].
 * @param connectionLost True when a previous healthy connection was lost and recovery
 *   is in progress or exhausted. When true with CONNECTING/AUTHENTICATING, the
 *   [io.sentient.android.chat.ConnectionBannerState.RECONNECTING] banner owns the UI;
 *   return [LoadingAffordance.NONE] to avoid duplication.
 * @param hasPending True when at least one send is queued in the PendingSend outbox.
 */
fun loadingAffordance(
    status: SdkStatus,
    connectionLost: Boolean,
    hasPending: Boolean,
): LoadingAffordance = when {
    hasPending -> LoadingAffordance.SENDING
    connectionLost -> LoadingAffordance.NONE
    status == SdkStatus.CONNECTING || status == SdkStatus.AUTHENTICATING ->
        LoadingAffordance.CONNECTING
    else -> LoadingAffordance.NONE
}
