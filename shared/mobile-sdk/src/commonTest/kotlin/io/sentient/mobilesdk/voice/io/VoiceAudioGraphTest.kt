package io.sentient.mobilesdk.voice.io

import kotlin.test.Test
import kotlin.test.assertEquals

class VoiceAudioGraphTest {

    @Test
    fun off_off_tears_down() {
        val g = voiceAudioGraph(mic = false, playback = false)
        assertEquals(VoiceAudioGraph(inputTap = false, player = false, vpio = false, output = false, running = false), g)
    }

    @Test
    fun off_on_player_only_no_vpio() {
        val g = voiceAudioGraph(mic = false, playback = true)
        assertEquals(VoiceAudioGraph(inputTap = false, player = true, vpio = false, output = true, running = true), g)
    }

    @Test
    fun on_off_mic_tap_no_vpio_no_echo_source() {
        val g = voiceAudioGraph(mic = true, playback = false)
        assertEquals(VoiceAudioGraph(inputTap = true, player = false, vpio = false, output = true, running = true), g)
    }

    @Test
    fun on_on_full_duplex_vpio_on() {
        val g = voiceAudioGraph(mic = true, playback = true)
        assertEquals(VoiceAudioGraph(inputTap = true, player = true, vpio = true, output = true, running = true), g)
    }

    @Test
    fun vpio_only_when_both_axes_active() {
        // VPIO is enabled EXACTLY when there is echo to cancel (mic + playback).
        listOf(false to false, true to false, false to true).forEach { (mic, pb) ->
            assertEquals(false, voiceAudioGraph(mic, pb).vpio, "vpio must be off for ($mic,$pb)")
        }
        assertEquals(true, voiceAudioGraph(true, true).vpio)
    }
}