package cz.stremiooffline.tv.ui.catalog

internal data class DetailAccess(
  val catalogueCalls: Boolean,
  val extras: Boolean,
  val toLibrary: Boolean,
  val favourite: Boolean,
)

internal fun detailAccess(
  libraryBackend: Boolean,
  child: Boolean,
  childCatalogue: Boolean,
): DetailAccess {
  val catalogueCalls = !child || childCatalogue
  return DetailAccess(
    catalogueCalls = catalogueCalls,
    extras = !child,
    toLibrary = !child,
    favourite = !child || childCatalogue || libraryBackend,
  )
}
