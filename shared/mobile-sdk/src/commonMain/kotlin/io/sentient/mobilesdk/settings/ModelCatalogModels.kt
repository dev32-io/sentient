// ---------------------------------------------------------------------------
// ModelCatalogModels — mirror of GET /api/v1/providers/models
// (gateway/src/api/handlers/providers.ts + providers/catalogs/types.ts ModelEntry).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.settings

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive

/**
 * One selectable LLM model. `pricingPer1mPrompt` / `pricingPer1mCompletion` are
 * a number OR the string "included" — carried as a raw [JsonPrimitive] so both
 * shapes decode without failure. The UI layer formats it for display.
 */
@Serializable
data class ModelEntry(
    val id: String,
    val provider: String,
    val name: String,
    val description: String = "",
    val contextLength: Int = 0,
    val pricingPer1mPrompt: JsonPrimitive = JsonPrimitive(0),
    val pricingPer1mCompletion: JsonPrimitive = JsonPrimitive(0),
    val supportsTools: Boolean = false,
    val supportsVision: Boolean = false,
)

/** GET /api/v1/providers/models → {models, stale}. */
@Serializable
data class ModelCatalog(val models: List<ModelEntry> = emptyList(), val stale: Boolean = false)
