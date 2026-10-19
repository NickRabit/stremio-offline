package cz.stremiooffline.tv.ui.search

import cz.stremiooffline.tv.data.GlobalSearchLibraryDto

/** One library level the Search page is fixed to, independent of the rail's search scope. */
data class LibrarySearchScope(
  val library: GlobalSearchLibraryDto?,
  val sources: List<String>,
  val title: String,
)
