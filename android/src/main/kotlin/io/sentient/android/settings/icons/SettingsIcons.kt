// ---------------------------------------------------------------------------
// SettingsIcons — Compose ImageVectors transcribed from the webui SVG set at
// gateway/webui/src/components/common/icons/*.tsx, for the Settings root list
// (Soul group icons here; User/Admin/Support + Diagnostics in SettingsIconsUser.kt
// — split per the 300-line file cap).
//
// Transcription method: each source SVG uses `fill="none" stroke="currentColor"`
// with 24x24 viewBox — a pure outline glyph. [strokeIcon] parses the SVG `d`
// path-data string (via the same mini-language androidx.compose.ui.graphics.vector.
// PathParser implements) into an ImageVector with a null fill + solid stroke; the
// Icon() composable's `tint` recolors every non-transparent pixel regardless of the
// placeholder stroke color baked in here, so the literal Color.Black below never
// actually renders — only alpha/shape matters.
//
// `<rect>`/`<circle>`/`<line>`/`<polygon>` primitives (no source `d` attribute) are
// hand-converted to their equivalent path-data using the standard SVG formulas
// (rounded-rect via 4 quarter-arcs, circle via 2 half-arcs, line/polygon via M/L).
// Multiple source <path> elements for one icon are concatenated into a single `d`
// string (multiple "M" subpaths) since PathParser accepts multi-subpath data.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.icons

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

private const val VIEWPORT = 24f
private val ICON_DP = VIEWPORT.dp
private const val DEFAULT_STROKE_WIDTH = 1.7f

/** Namespace marker — icons are extension vals on this object, mirroring Icons.Filled.*. */
object SettingsIcons

/**
 * Builds a single-path stroke-only [ImageVector] from an SVG `d`-style path string.
 * [strokeWidth] mirrors the source SVG's `stroke-width` (1.7 for most of the set;
 * 2 for volume-2, matching its source).
 */
internal fun strokeIcon(name: String, pathData: String, strokeWidth: Float = DEFAULT_STROKE_WIDTH): ImageVector =
    ImageVector.Builder(
        name = name,
        defaultWidth = ICON_DP,
        defaultHeight = ICON_DP,
        viewportWidth = VIEWPORT,
        viewportHeight = VIEWPORT,
    ).addPath(
        pathData = PathParser().parsePathString(pathData).toNodes(),
        fill = null,
        stroke = SolidColor(Color.Black),
        strokeLineWidth = strokeWidth,
        strokeLineCap = StrokeCap.Round,
        strokeLineJoin = StrokeJoin.Round,
    ).build()

private var _brain: ImageVector? = null

/** brain.tsx — Memory category icon. */
val SettingsIcons.Brain: ImageVector
    get() {
        _brain?.let { return it }
        val built = strokeIcon(
            name = "Brain",
            pathData = "M12 5a3 3 0 0 0-3-3 3 3 0 0 0-3 3 2.5 2.5 0 0 0-2 4 2.5 2.5 0 0 0 0 4 2.5 2.5 0 0 0 2 4 3 3 0 0 0 3 3 3 3 0 0 0 3-3z " +
                "M12 5a3 3 0 0 1 3-3 3 3 0 0 1 3 3 2.5 2.5 0 0 1 2 4 2.5 2.5 0 0 1 0 4 2.5 2.5 0 0 1-2 4 3 3 0 0 1-3 3 3 3 0 0 1-3-3z " +
                "M12 5v14",
        )
        _brain = built
        return built
    }

private var _drama: ImageVector? = null

/** drama.tsx — Personalities category icon. */
val SettingsIcons.Drama: ImageVector
    get() {
        _drama?.let { return it }
        val built = strokeIcon(
            name = "Drama",
            pathData = "M10 11h.01 M14 6h.01 M18 6h.01 M6.5 13.1h.01 " +
                "M22 5c0 9-4 12-6 12s-6-3-6-12c0-2 2-3 6-3s6 1 6 3 " +
                "M17.4 9.9c-.8.8-2 .8-2.8 0 " +
                "M10.1 7.1C9 7.2 7.7 7.7 6 8.6c-3.5 2-4.7 3.9-3.7 5.6 4.5 7.8 9.5 8.4 11.2 7.4.9-.5 1.9-2.1 1.9-4.7 " +
                "M9.1 16.5c.3-1.1 1.4-1.7 2.4-1.4",
        )
        _drama = built
        return built
    }

private var _waveform: ImageVector? = null

/** waveform.tsx — Voice category icon. */
val SettingsIcons.Waveform: ImageVector
    get() {
        _waveform?.let { return it }
        val built = strokeIcon(
            name = "Waveform",
            pathData = "M2 13a2 2 0 0 0 2-2V7a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0V4a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0v-4a2 2 0 0 1 2-2",
        )
        _waveform = built
        return built
    }

private var _volume2: ImageVector? = null

/** volume-2.tsx — Audio category icon (source stroke-width is 2, not 1.7). */
val SettingsIcons.Volume2: ImageVector
    get() {
        _volume2?.let { return it }
        val built = strokeIcon(
            name = "Volume2",
            pathData = "M11 5L6 9L2 9L2 15L6 15L11 19L11 5Z " +
                "M15.54 8.46a5 5 0 0 1 0 7.07 " +
                "M19.07 4.93a10 10 0 0 1 0 14.14",
            strokeWidth = 2f,
        )
        _volume2 = built
        return built
    }

private var _cpu: ImageVector? = null

/** cpu.tsx — Model category icon. */
val SettingsIcons.Cpu: ImageVector
    get() {
        _cpu?.let { return it }
        val built = strokeIcon(
            name = "Cpu",
            pathData = "M6 4L18 4A2 2 0 0 1 20 6L20 18A2 2 0 0 1 18 20L6 20A2 2 0 0 1 4 18L4 6A2 2 0 0 1 6 4Z " +
                "M9 9L15 9L15 15L9 15Z " +
                "M15 2v2 M15 20v2 M2 15h2 M2 9h2 M20 15h2 M20 9h2 M9 2v2 M9 20v2",
        )
        _cpu = built
        return built
    }

private var _wrench: ImageVector? = null

/** wrench.tsx — Tools category icon. */
val SettingsIcons.Wrench: ImageVector
    get() {
        _wrench?.let { return it }
        val built = strokeIcon(
            name = "Wrench",
            pathData = "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
        )
        _wrench = built
        return built
    }

private var _bookOpen: ImageVector? = null

/** book-open.tsx — System Prompt category icon. */
val SettingsIcons.BookOpen: ImageVector
    get() {
        _bookOpen?.let { return it }
        val built = strokeIcon(
            name = "BookOpen",
            pathData = "M12 7v14 " +
                "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",
        )
        _bookOpen = built
        return built
    }

private var _slidersH: ImageVector? = null

/** sliders-h.tsx — Advanced category icon. */
val SettingsIcons.SlidersH: ImageVector
    get() {
        _slidersH?.let { return it }
        val built = strokeIcon(
            name = "SlidersH",
            pathData = "M21 4L14 4 M10 4L3 4 M21 12L12 12 M8 12L3 12 M21 20L16 20 M12 20L3 20 " +
                "M14 2L14 6 M8 10L8 14 M16 18L16 22",
        )
        _slidersH = built
        return built
    }
