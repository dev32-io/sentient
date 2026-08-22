package io.sentient.mobilesdk.settings

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class FishFiltersTest {
    private fun voice(id: String, tags: List<String>, languages: List<String> = listOf("EN"), title: String = id, created: String = id) =
        FishVoiceEntry(id, title, languages = languages, tags = tags, createdAt = created)

    @Test fun dirtyTagsDeriveCanonicalDeterministicOptions() {
        val options = deriveFishFilterOptions(listOf(
            voice("1", listOf("Male", "Young", "Warm"), listOf("EN", "ar")),
            voice("2", listOf("female", "middle-aged", "warm", "Calm"), listOf("zh")),
            voice("3", listOf("OLD", "BRIGHT"), listOf("th")),
        ))
        assertEquals(listOf("en", "zh"), options.languages)
        assertEquals(listOf("Female", "Male"), options.genders)
        assertEquals(listOf("Young", "Middle-aged", "Old"), options.ages)
        assertEquals(listOf("BRIGHT", "Calm", "Warm"), options.vibes)
    }

    @Test fun facetsAreOrWithinAndAcross() {
        val entries = listOf(
            voice("male-young", listOf("male", "young", "warm")),
            voice("female-old", listOf("female", "old", "warm")),
            voice("male-old", listOf("male", "old", "calm")),
        )
        val filter = FishFilterState(genders = listOf("Male", "Female"), ages = listOf("OLD"), vibes = listOf("warm", "CALM"))
        assertEquals(listOf("female-old", "male-old"), filterFishVoices(entries, filter).map { it.id })
    }

    @Test fun sortingAndActiveStateMatchCatalogSemantics() {
        val entries = listOf(voice("b", emptyList(), title = "zulu", created = "2024-01-01"), voice("a", emptyList(), title = "Alpha", created = "2025-01-01"))
        assertEquals(listOf("a", "b"), sortFishVoices(entries, FishSort.RECENT).map { it.id })
        assertEquals(listOf("a", "b"), sortFishVoices(entries, FishSort.AZ).map { it.id })
        assertEquals(listOf("b", "a"), sortFishVoices(entries, FishSort.POPULAR).map { it.id })
        assertFalse(isFishFilterActive(FishFilterState()))
        assertFalse(isFishFilterActive(FishFilterState(sort = FishSort.AZ)))
        assertEquals(listOf("x"), toggleFishValue(emptyList(), "x"))
    }
}
