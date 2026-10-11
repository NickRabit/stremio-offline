package cz.stremiooffline.tv.data

/** Where a search looks, the same three fields the web's `parseSearchScope` produces: nothing
 *  for every addon, an addon key for one addon, or a full catalogue for one list. */
data class SearchScope(
  val addonKey: String? = null,
  val catalogType: String? = null,
  val catalogId: String? = null,
) {
  val onCatalog: Boolean get() = !addonKey.isNullOrEmpty() && !catalogId.isNullOrEmpty()
}
