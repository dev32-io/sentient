package io.sentient.android.chat.composer

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Pins the task-pill min-width clamp, mirroring the webui pin
 * (gateway/webui/src/styles/components.css `.tool-pill` `clamp(112px, 42cqw,
 * 200px)`) and iOS's `ComposerLayoutTests`. A drifted floor/ceiling/fraction
 * on any one platform makes the same turn look inconsistent depending on
 * which client renders it.
 */
class ComposerTaskStripLayoutTest {

    @Test fun `floors at the minimum on a narrow strip`() {
        assertEquals(TASK_PILL_MIN_WIDTH_FLOOR_DP, taskPillMinWidth(100f))
    }

    @Test fun `still floors just below the floor crossover width`() {
        // 260 * 0.42 = 109.2, under the floor — pinned via a plain value rather
        // than an inverse-computed crossover, which doesn't round-trip exactly
        // in floating point and made this boundary test flaky.
        assertEquals(TASK_PILL_MIN_WIDTH_FLOOR_DP, taskPillMinWidth(260f))
    }

    @Test fun `scales at the strip fraction in the middle band`() {
        val stripWidth = 330f
        assertEquals(stripWidth * TASK_PILL_WIDTH_STRIP_FRACTION, taskPillMinWidth(stripWidth))
    }

    @Test fun `still ceils just above the ceiling crossover width`() {
        // 480 * 0.42 = 201.6, over the ceiling.
        assertEquals(TASK_PILL_MAX_WIDTH_DP, taskPillMinWidth(480f))
    }

    @Test fun `caps at the ceiling on a wide desktop strip`() {
        assertEquals(TASK_PILL_MAX_WIDTH_DP, taskPillMinWidth(1000f))
    }
}
