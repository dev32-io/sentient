package io.sentient.mobilesdk.voice.io

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MicLevelMeterTest {
    @Test
    fun framesBySampleCountAcrossCallbackBoundaries() {
        val snapshots = mutableListOf<MicLevelEnvelope>()
        val meter = MicLevelMeter(snapshots::add)
        meter.accept(ShortArray(799) { 10_000 })
        assertTrue(snapshots.isEmpty())
        meter.accept(ShortArray(1) { 10_000 })
        assertEquals(1, snapshots.size)
        assertEquals(32, snapshots.single().values.size)
        assertTrue(snapshots.single().active)
    }

    @Test
    fun oversizedCallbackProducesEveryCompleteWindow() {
        val snapshots = mutableListOf<MicLevelEnvelope>()
        MicLevelMeter(snapshots::add).accept(ShortArray(2_401) { 20_000 })
        assertEquals(3, snapshots.size)
    }

    @Test
    fun valuesAreLogMappedAndSmoothed() {
        val snapshots = mutableListOf<MicLevelEnvelope>()
        val meter = MicLevelMeter(snapshots::add)
        repeat(3) { meter.accept(ShortArray(800) { 16_384 }) }
        val level = snapshots.last().values.last()
        assertTrue(level in 0f..1f)
        assertTrue(level > snapshots.first().values.last())
    }

    @Test
    fun resetRestoresSilentHistory() {
        val snapshots = mutableListOf<MicLevelEnvelope>()
        val meter = MicLevelMeter(snapshots::add)
        meter.accept(ShortArray(800) { Short.MAX_VALUE })
        meter.reset()
        val reset = snapshots.last()
        assertFalse(reset.active)
        assertEquals(List(32) { 0f }, reset.values)
    }
}
