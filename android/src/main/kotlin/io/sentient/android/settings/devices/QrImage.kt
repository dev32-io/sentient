// ---------------------------------------------------------------------------
// QrImage — renders the Signal device-linking QR from the gateway's `qrDataUrl`.
//
// QR/URI finding: the gateway (devices.ts → pairing-coordinator) exposes ONLY a
// `data:image/png;base64,…` PNG — the raw signal-cli `tsdevice:` device-link URI is
// NEVER sent over the wire, so there is no `sgnl://` / `https` deep-link to open and
// nothing to decode. We therefore render the QR image directly by decoding the
// base64 payload to a Bitmap (android.util.Base64 + BitmapFactory) — no Coil, no new
// dependency. Same-device limitation: the linking QR must be SCANNED by the Signal
// app on ANOTHER device ("Link New Device"); you cannot scan a code shown on the
// same screen that is displaying it. The dialog copy states this.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.devices

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.testTag
import io.sentient.android.theme.LocalTokens
import androidx.compose.ui.graphics.Color
import io.sentient.mobilesdk.design.Colors

private const val BASE64_MARKER = "base64,"

/**
 * Draws the QR PNG carried by [dataUrl] (a `data:…;base64,…` string). Decoding is
 * memoized on [dataUrl]. A malformed payload renders a fallback line rather than
 * crashing.
 */
@Composable
fun QrImage(dataUrl: String, modifier: Modifier = Modifier) {
    val bitmap = remember(dataUrl) { decodeDataUrl(dataUrl) }
    if (bitmap != null) {
        Image(
            bitmap = bitmap,
            contentDescription = "Signal device-linking QR code",
            modifier = modifier.testTag("settings-devices-qr"),
        )
    } else {
        Text(
            "Couldn't render the linking code.",
            color = Color(Colors.stop),
            fontSize = LocalTokens.current.type.sm,
        )
    }
}

/** Decode a base64 data-URL PNG to an [ImageBitmap]; null on any malformed input. */
private fun decodeDataUrl(dataUrl: String): ImageBitmap? {
    val marker = dataUrl.indexOf(BASE64_MARKER)
    if (marker < 0) return null
    return runCatching {
        val bytes = Base64.decode(dataUrl.substring(marker + BASE64_MARKER.length), Base64.DEFAULT)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
    }.getOrNull()
}
