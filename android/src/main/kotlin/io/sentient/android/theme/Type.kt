package io.sentient.android.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import io.sentient.android.R

val Fraunces = FontFamily(
    Font(R.font.fraunces_regular, FontWeight.Normal),
    Font(R.font.fraunces_medium, FontWeight.Medium),
    Font(R.font.fraunces_semibold, FontWeight.SemiBold),
)

val DMSans = FontFamily(
    Font(R.font.dm_sans_regular, FontWeight.Normal),
    Font(R.font.dm_sans_medium, FontWeight.Medium),
    Font(R.font.dm_sans_semibold, FontWeight.SemiBold),
    Font(R.font.dm_sans_bold, FontWeight.Bold),
)

val JetBrainsMono = FontFamily(
    Font(R.font.jetbrains_mono_regular, FontWeight.Normal),
    Font(R.font.jetbrains_mono_medium, FontWeight.Medium),
)

/** Material typography rebased on DM Sans (body/UI). Brand/titles use Fraunces directly. */
val DuskTypography: Typography = Typography().let { t ->
    t.copy(
        bodyLarge = t.bodyLarge.copy(fontFamily = DMSans),
        bodyMedium = t.bodyMedium.copy(fontFamily = DMSans),
        bodySmall = t.bodySmall.copy(fontFamily = DMSans),
        labelLarge = t.labelLarge.copy(fontFamily = DMSans),
        labelMedium = t.labelMedium.copy(fontFamily = DMSans),
        labelSmall = t.labelSmall.copy(fontFamily = DMSans),
        titleLarge = t.titleLarge.copy(fontFamily = DMSans),
        titleMedium = t.titleMedium.copy(fontFamily = DMSans),
        titleSmall = t.titleSmall.copy(fontFamily = DMSans),
    )
}
