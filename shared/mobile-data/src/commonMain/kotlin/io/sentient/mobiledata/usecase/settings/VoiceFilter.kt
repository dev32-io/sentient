// ---------------------------------------------------------------------------
// VoiceFilter — pure, unit-tested voice-pack filtering. Field-for-field mirror of
// the webui gateway/webui/src/components/voices/voice-filter.ts filterPacks:
// source filter + exact language + all-selected-tags-present + case-insensitive
// search over name+description+tags. No state, no I/O — the VM feeds a snapshot in
// and renders the result out.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.usecase.settings

import io.sentient.mobilesdk.settings.VoiceSummary

private const val SOURCE_ALL = "all"

/** Filter inputs. Mirrors the webui VoiceFilterState (source/language "" = no filter). */
data class VoiceFilterState(
    val query: String = "",
    /** "all" | "builtin" | "user" — matches the wire `source` value. */
    val source: String = SOURCE_ALL,
    /** ALL selected tags must be present on a pack for it to pass. */
    val tags: List<String> = emptyList(),
    /** Exact-match language code; "" means no language filter. */
    val language: String = "",
)

/** Source + language + all-tags-present + case-insensitive search over name+description+tags. */
fun filterVoices(voices: List<VoiceSummary>, filter: VoiceFilterState): List<VoiceSummary> {
    val q = filter.query.trim().lowercase()
    return voices.filter { p ->
        when {
            filter.source != SOURCE_ALL && p.source != filter.source -> false
            filter.language != "" && p.language != filter.language -> false
            filter.tags.isNotEmpty() && !filter.tags.all { it in p.tags } -> false
            q == "" -> true
            else -> (listOf(p.name, p.description) + p.tags).joinToString(" ").lowercase().contains(q)
        }
    }
}

/** Sorted union of every tag across packs (tag-filter options for the UI). */
fun deriveTagOptions(voices: List<VoiceSummary>): List<String> =
    voices.flatMap { it.tags }.distinct().sorted()

/** Sorted union of every non-empty language code across packs (language-filter options). */
fun deriveLanguageOptions(voices: List<VoiceSummary>): List<String> =
    voices.mapNotNull { it.language.ifEmpty { null } }.distinct().sorted()
