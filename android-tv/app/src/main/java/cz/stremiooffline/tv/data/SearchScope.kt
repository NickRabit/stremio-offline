package cz.stremiooffline.tv.data

import kotlinx.serialization.Serializable

/** Where a search looks, the same three fields the web's `parseSearchScope` produces: nothing
 *  for every addon, an addon key for one addon, or a full catalogue for one list. */
@Serializable
data class SearchScope(
  val addonKey: String? = null,
  val catalogType: String? = null,
  val catalogId: String? = null,
)
