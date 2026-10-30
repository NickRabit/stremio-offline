package cz.stremiooffline.tv.ui.search

import cz.stremiooffline.tv.data.GlobalSearchLibraryDto

/** One library level the Search page is fixed to, independent of the rail's search scope. */
data class LibrarySearchScope(
  val library: GlobalSearchLibraryDto?,
  val sources: List<String>,
  val title: String,
)

/** The Search page's starting filters for this level. An unknown source selects nothing. */
fun LibrarySearchScope.toPreset(): SearchPreset {
  val wire = sources.singleOrNull() ?: return SearchPreset()
  val source = SourceClass.entries.firstOrNull { it.wire == wire } ?: return SearchPreset()
  return SearchPreset(
    sources = setOf(source),
    library = library?.let { LibraryFilter(it, source, title) },
  )
}
