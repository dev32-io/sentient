// ---------------------------------------------------------------------------
// Pcm16FloatBuffer.ios.kt — PCM16 LE bytes → AVAudioPCMBuffer (float32 mono).
//
// The AVAudioPlayerNode renders float buffers. The assistant downlink arrives as
// PCM16 LE (48k mono per session.ready). We decode to normalized Float32 via the
// commonMain [pcm16ToFloat32] (the A2 codec, shared with web-sdk), then fill the
// player format's deinterleaved channel-0 float data.
//
// K/N AVFAudio cinterop: floatChannelData is a CPointer<CPointerVar<FloatVar>> —
// channel 0 holds the mono samples; index per-sample. frameLength must be set so
// the player knows how many frames to render.
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package io.sentient.mobilesdk.audioio

import io.sentient.mobilesdk.audio.pcm16ToFloat32
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.get
import kotlinx.cinterop.set
import platform.AVFAudio.AVAudioFormat
import platform.AVFAudio.AVAudioPCMBuffer

/**
 * Builds an [AVAudioPCMBuffer] in [playerFormat] (float32 mono) from PCM16 LE
 * [pcm16] bytes, or null when empty / allocation fails.
 *
 * [playerFormat] must be a non-interleaved float format whose sample rate equals
 * the PCM16 source rate (the adapter connects the player at the downlink rate, so
 * no resample is needed — the bytes map 1:1 to float frames).
 *
 * [gain] is a software playback makeup multiplier applied to each sample, hard-clamped
 * to [-1, 1] so a boost can't wrap the float. 1.0 = passthrough (the codec's job). See
 * the caller's PLAYBACK_MAKEUP_GAIN for why the iOS downlink needs a lift.
 */
internal fun pcm16ToFloatBuffer(
    pcm16: ByteArray,
    playerFormat: AVAudioFormat,
    gain: Float = 1.0f,
): AVAudioPCMBuffer? {
    val samples = pcm16ToFloat32(pcm16)
    if (samples.isEmpty()) return null
    val frames = samples.size.toUInt()
    val buffer = AVAudioPCMBuffer(pCMFormat = playerFormat, frameCapacity = frames)
    val channel = buffer.floatChannelData?.get(0) ?: return null
    for (i in samples.indices) {
        channel[i] = if (gain == 1.0f) samples[i] else (samples[i] * gain).coerceIn(-1.0f, 1.0f)
    }
    buffer.frameLength = frames
    return buffer
}
