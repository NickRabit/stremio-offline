package cz.stremiooffline.tv.ui.search

import cz.stremiooffline.tv.data.GlobalSearchLibraryDto
import cz.stremiooffline.tv.data.SearchScope

/** A library level the search is limited to; only valid while [source] is the sole source. */
data class LibraryFilter(
  val library: GlobalSearchLibraryDto,
  val source: SourceClass,
  val title: String,
)

/** What the Search page starts with when another section opens it. */
data class SearchPreset(
  val sources: Set<SourceClass> = emptySet(),
  val scope: SearchScope = SearchScope(),
  val library: LibraryFilter? = null,
  val query: String? = null,
)
