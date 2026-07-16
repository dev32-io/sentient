// ---------------------------------------------------------------------------
// VoiceFilterTest — pure filter-logic tests (per testing rules: the voice filter
// is unit-testable business logic, tested directly, no mocks). Mirrors the webui
// voice-filter.test.ts assertions.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.usecase.settings

import io.sentient.mobilesdk.settings.VoiceSummary
import kotlin.test.Test
import kotlin.test.assertEquals

private fun voice(
    id: String = "v",
    name: String = "Alpha",
    description: String = "",
    tags: List<String> = emptyList(),
    language: String = "",
    source: String = "user",
): VoiceSummary = VoiceSummary(
    voiceId = id, name = name, description = description, tags = tags, language = language, source = source,
)

class VoiceFilterTest {

    @Test
    fun `empty filter returns all`() {
        val packs = listOf(voice(id = "1"), voice(id = "2"))
        assertEquals(2, filterVoices(packs, VoiceFilterState()).size)
    }

    @Test
    fun `filters by exact language`() {
        val packs = listOf(voice(language = "zh"), voice(language = "en"), voice(language = ""))
        assertEquals(1, filterVoices(packs, VoiceFilterState(language = "zh")).size)
    }

    @Test
    fun `blank language means no language filter`() {
        val packs = listOf(voice(language = "zh"), voice(language = "en"))
        assertEquals(2, filterVoices(packs, VoiceFilterState(language = "")).size)
    }

    @Test
    fun `filters by source`() {
        val packs = listOf(voice(source = "builtin"), voice(source = "user"))
        assertEquals(1, filterVoices(packs, VoiceFilterState(source = "builtin")).size)
    }

    @Test
    fun `requires ALL selected tags present`() {
        val packs = listOf(
            voice(id = "1", tags = listOf("bright", "warm")),
            voice(id = "2", tags = listOf("bright")),
        )
        assertEquals(1, filterVoices(packs, VoiceFilterState(tags = listOf("bright", "warm"))).size)
    }

    @Test
    fun `search is case-insensitive over name description and tags`() {
        val packs = listOf(
            voice(id = "1", name = "Alpha"),
            voice(id = "2", name = "Beta", description = "a bright one"),
            voice(id = "3", name = "Gamma", tags = listOf("BRIGHT")),
        )
        assertEquals(1, filterVoices(packs, VoiceFilterState(query = "alpha")).size)
        assertEquals(2, filterVoices(packs, VoiceFilterState(query = "bright")).size)
    }

    @Test
    fun `combined filters intersect`() {
        val packs = listOf(
            voice(id = "1", name = "Alpha", language = "en", tags = listOf("warm")),
            voice(id = "2", name = "Alpha", language = "zh", tags = listOf("warm")),
        )
        val out = filterVoices(packs, VoiceFilterState(query = "alpha", language = "en", tags = listOf("warm")))
        assertEquals(listOf("1"), out.map { it.voiceId })
    }

    @Test
    fun `derive options are sorted and deduped`() {
        val packs = listOf(voice(tags = listOf("b", "a"), language = "zh"), voice(tags = listOf("a"), language = "en"))
        assertEquals(listOf("a", "b"), deriveTagOptions(packs))
        assertEquals(listOf("en", "zh"), deriveLanguageOptions(packs))
    }
}
