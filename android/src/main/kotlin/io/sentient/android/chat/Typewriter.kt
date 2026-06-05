// Typewriter — pure time→reveal engine porting webui use-typewriter-buffer.ts.
// Rates from shared tokens (mobilesdk.design.Typewriter). A Compose driver
// (rememberTypewriterText) calls typewriterTick per frame; this stays pure/testable.
package io.sentient.android.chat

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import io.sentient.mobilesdk.design.Typewriter as Cfg

data class TypewriterState(val visibleCount: Int = 0, val pauseUntil: Double = 0.0)

private val sentencePause = Cfg.sentencePauseMs / 1000.0
private val paragraphPause = Cfg.paragraphPauseMs / 1000.0

/** Advance visibleCount toward target.size for elapsed [dt] at clock [now] (seconds). */
fun typewriterTick(
    s: TypewriterState,
    target: List<Char>,
    streamComplete: Boolean,
    dt: Double,
    now: Double,
): TypewriterState {
    val n = target.size
    if (s.visibleCount >= n) return s
    if (now < s.pauseUntil) return s
    val gap = n - s.visibleCount
    val raw = if (streamComplete) Cfg.maxRate.toDouble() else Cfg.baseRate * (1 + gap * Cfg.gapGain)
    val rate = minOf(Cfg.maxRate.toDouble(), maxOf(Cfg.minRate.toDouble(), raw))
    val advance = maxOf(1, (rate * dt).toInt())
    // CRITICAL: stop the advance AT the first sentence/paragraph boundary in the
    // window [visibleCount+1 .. candidate], so a fast tick can't skip a pause.
    val candidate = minOf(n, s.visibleCount + advance)
    val stop = firstBoundaryStop(target, s.visibleCount + 1, candidate)
    val newCount = stop ?: candidate
    val pause = boundaryPause(target, newCount)
    return s.copy(visibleCount = newCount, pauseUntil = if (pause != null) now + pause else s.pauseUntil)
}

/** First index (1-based count) in [from..through] whose just-revealed char is a boundary; else null. */
private fun firstBoundaryStop(t: List<Char>, from: Int, through: Int): Int? {
    var i = from
    while (i <= through) {
        if (boundaryPause(t, i) != null) return i
        i++
    }
    return null
}

private fun boundaryPause(t: List<Char>, upto: Int): Double? {
    if (upto < 1 || upto > t.size) return null
    val last = t[upto - 1]
    if (last == '\n' && upto >= 2 && t[upto - 2] == '\n') return paragraphPause
    if (last == '.' || last == '!' || last == '?') return sentencePause
    return null
}

/** Revealed text for a streaming bubble; full text when not streaming. No cursor. */
@Composable
fun rememberTypewriterText(content: String, streaming: Boolean): String {
    if (!streaming) return content
    val latest by rememberUpdatedState(content)
    var state by remember { mutableStateOf(TypewriterState()) }
    LaunchedEffect(Unit) {
        var last = 0.0
        while (true) {
            withFrameNanos { nanos ->
                val now = nanos / 1_000_000_000.0
                val dt = if (last == 0.0) 0.0 else now - last
                last = now
                state = typewriterTick(state, latest.toList(), streamComplete = false, dt = dt, now = now)
            }
        }
    }
    val chars = latest.toList()
    return chars.subList(0, state.visibleCount.coerceAtMost(chars.size)).joinToString("")
}
