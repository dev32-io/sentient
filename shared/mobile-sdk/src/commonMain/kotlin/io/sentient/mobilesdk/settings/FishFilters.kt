package io.sentient.mobilesdk.settings

/** Canonical, side-effect-free Fish catalog facet behaviour (kept in commonMain). */
data class FishFilterOptions(
    val languages: List<String>,
    val genders: List<String>,
    val ages: List<String>,
    val vibes: List<String>,
)

data class FishFilterState(
    val query: String = "",
    val language: String = "",
    val genders: List<String> = emptyList(),
    val ages: List<String> = emptyList(),
    val vibes: List<String> = emptyList(),
    val sort: FishSort = FishSort.POPULAR,
)

enum class FishSort { POPULAR, RECENT, AZ }

private val supportedFishLanguages = setOf("zh", "en", "ja", "ko", "de", "fr", "ru", "pt", "es", "it")
private val ages = listOf("young", "middle-aged", "old")
private val genders = setOf("male", "female")
private fun key(value: String) = value.trim().lowercase()
private fun supported(value: String) = key(value) in supportedFishLanguages

fun deriveFishFilterOptions(voices: List<FishVoiceEntry>): FishFilterOptions {
    val languages = mutableSetOf<String>()
    val genderOptions = linkedMapOf<String, String>()
    val ageOptions = linkedMapOf<String, String>()
    val vibeOptions = linkedMapOf<String, String>()
    voices.forEach { voice ->
        voice.languages.filter(::supported).mapTo(languages) { key(it) }
        voice.tags.forEach { raw ->
            val k = key(raw)
            when {
                k in genders -> if (!genderOptions.containsKey(k)) genderOptions[k] = if (k == "male") "Male" else "Female"
                k in ages -> if (!ageOptions.containsKey(k)) ageOptions[k] = if (k == "middle-aged") "Middle-aged" else k.replaceFirstChar { it.uppercase() }
                else -> if (k.isNotEmpty() && !vibeOptions.containsKey(k)) vibeOptions[k] = raw.trim()
            }
        }
    }
    return FishFilterOptions(
        languages = languages.sorted(),
        genders = genderOptions.values.sorted(),
        ages = ages.filter { it in ageOptions }.map { ageOptions.getValue(it) },
        vibes = vibeOptions.values.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it }),
    )
}

fun canonicalFishVibe(value: String, options: FishFilterOptions): String =
    options.vibes.firstOrNull { key(it) == key(value) } ?: value

fun isFishFilterActive(filter: FishFilterState): Boolean =
    filter.query.trim().isNotEmpty() || (key(filter.language).isNotEmpty() && key(filter.language) != "all") ||
        filter.genders.isNotEmpty() || filter.ages.isNotEmpty() || filter.vibes.isNotEmpty()

/** Facets are OR within a bucket and AND across buckets. Query is server-side and ignored. */
fun filterFishVoices(voices: List<FishVoiceEntry>, filter: FishFilterState): List<FishVoiceEntry> {
    val language = key(filter.language)
    val gs = filter.genders.map(::key).toSet()
    val as_ = filter.ages.map(::key).toSet()
    val vs = filter.vibes.map(::key).toSet()
    return voices.filter { voice ->
        (language.isEmpty() || language == "all" || voice.languages.any { key(it) == language }) &&
            (gs.isEmpty() || voice.tags.any { key(it) in gs }) &&
            (as_.isEmpty() || voice.tags.any { key(it) in as_ }) &&
            (vs.isEmpty() || voice.tags.any { key(it) in vs })
    }
}

fun sortFishVoices(voices: List<FishVoiceEntry>, sort: FishSort): List<FishVoiceEntry> = when (sort) {
    FishSort.POPULAR -> voices
    FishSort.RECENT -> voices.sortedByDescending { it.createdAt }
    FishSort.AZ -> voices.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.title })
}

fun toggleFishValue(values: List<String>, value: String): List<String> =
    if (values.any { it == value }) values.filterNot { it == value } else values + value

fun resetFishFilters(): FishFilterState = FishFilterState()
