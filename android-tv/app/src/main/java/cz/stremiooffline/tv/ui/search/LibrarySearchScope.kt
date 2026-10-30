package cz.stremiooffline.tv.ui.search

import cz.stremiooffline.tv.data.GlobalSearchLibraryDto

/** The library level a library's Search action starts the Search page on; the viewer can clear it. */
data class LibrarySearchScope(
  val library: GlobalSearchLibraryDto?,
  val sources: List<String>,
  val title: String,
)

/** The Search page's starting filters for this level. No library selects every library and no chip;
 *  a library needs exactly one known source, and an unknown one selects nothing. */
fun LibrarySearchScope.toPreset(): SearchPreset {
  if (library == null) return SearchPreset(sources = LibrarySources)
  val wire = sources.singleOrNull() ?: return SearchPreset()
  val source = SourceClass.entries.firstOrNull { it.wire == wire } ?: return SearchPreset()
  return SearchPreset(
    sources = LibrarySources,
    library = LibraryFilter(library, source, title),
  )
}
