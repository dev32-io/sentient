// ---------------------------------------------------------------------------
// VoiceLanguages — Kotlin mirror of the canonical Qwen3-TTS language set.
//
// MIRROR of shared/config/src/languages.ts (LANGUAGE_DISPLAY / SUPPORTED_LANGUAGES /
// normalizeLanguage). No KMP copy of this list existed yet, so it is transcribed
// here for the Android voice UI. Keep in lockstep with the TS source and the
// service's Python mirror (LocalTTSService/src/local_tts/languages.py). Fish Audio
// returns codes outside this set (ar/hi/th/…) — those normalize to "" on import.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.voice

import io.sentient.android.settings.components.SelectOption

/** One supported TTS language: wire [code], display [flag] + [name]. */
data class VoiceLanguage(val code: String, val flag: String, val name: String)

/** Order + values mirror shared/config LANGUAGE_DISPLAY exactly. */
val SUPPORTED_LANGUAGES: List<VoiceLanguage> = listOf(
    VoiceLanguage("zh", "🇨🇳", "Chinese"),
    VoiceLanguage("en", "🇺🇸", "English"),
    VoiceLanguage("ja", "🇯🇵", "Japanese"),
    VoiceLanguage("ko", "🇰🇷", "Korean"),
    VoiceLanguage("de", "🇩🇪", "German"),
    VoiceLanguage("fr", "🇫🇷", "French"),
    VoiceLanguage("ru", "🇷🇺", "Russian"),
    VoiceLanguage("pt", "🇵🇹", "Portuguese"),
    VoiceLanguage("es", "🇪🇸", "Spanish"),
    VoiceLanguage("it", "🇮🇹", "Italian"),
)

private const val UNKNOWN_FLAG = "🌐" // 🌐 — fallback for an unmapped code

private val byCode: Map<String, VoiceLanguage> = SUPPORTED_LANGUAGES.associateBy { it.code }

/** "🇺🇸 English" for a known code, else "🌐 <UPPER>"; "" maps to "No language". */
fun voiceLanguageLabel(code: String): String {
    if (code.isEmpty()) return NO_LANGUAGE_LABEL
    val lang = byCode[code.lowercase()] ?: return "$UNKNOWN_FLAG ${code.uppercase()}"
    return "${lang.flag} ${lang.name}"
}

/** Lowercased code if supported, else "" — drops Fish's unsupported langs (normalizeLanguage). */
fun normalizeVoiceLanguage(code: String): String {
    val c = code.lowercase()
    return if (byCode.containsKey(c)) c else ""
}

private const val NO_LANGUAGE_LABEL = "No language"
private const val ALL_LANGUAGES_LABEL = "All languages"

/** Create-form options: "No language" + all 10 supported languages. */
fun formLanguageOptions(): List<SelectOption> =
    listOf(SelectOption("", NO_LANGUAGE_LABEL)) +
        SUPPORTED_LANGUAGES.map { SelectOption(it.code, "${it.flag} ${it.name}") }

/** Filter-bar options: "All languages" + only the codes present in the current list. */
fun filterLanguageOptions(presentCodes: List<String>): List<SelectOption> =
    listOf(SelectOption("", ALL_LANGUAGES_LABEL)) +
        presentCodes.map { SelectOption(it, voiceLanguageLabel(it)) }
