package cz.stremiooffline.tv.ui.detail

import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteLibraryApi
import cz.stremiooffline.tv.data.RemoteProviderIdsDto
import cz.stremiooffline.tv.ui.catalog.catalogueIdentity
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

internal data class RemoteMetadata(
  val item: RemoteItemDto,
  val seriesName: String? = null,
  val seriesIds: RemoteProviderIdsDto? = null,
)

internal fun initialRemoteMetadata(data: RemoteDetailData): RemoteMetadata = when (data.item.type) {
  "series" -> RemoteMetadata(data.item, data.item.name, data.item.providerIds)
  "episode", "season" -> RemoteMetadata(data.item, data.seriesName ?: data.item.seriesName, data.seriesIds)
  else -> RemoteMetadata(data.item)
}

/**
 * Fills the exact external identity only from stored fields or provider reads. An episode never
 * borrows its own id as the show id, and a failed or absent read leaves the origin item usable
 * without issuing a title-based guess.
 */
internal suspend fun resolveRemoteMetadata(
  api: RemoteLibraryApi,
  data: RemoteDetailData,
): RemoteMetadata {
  var item = data.item
  val hintedSeriesName = data.seriesName?.takeIf { it.isNotBlank() }
  val hintedSeriesIds = data.seriesIds?.takeIf { catalogueIdentity("series", it) != null }
  var seriesName = hintedSeriesName ?: item.seriesName?.takeIf { it.isNotBlank() }
  var seriesIds = hintedSeriesIds

  val needsItem = when (item.type) {
    "movie" -> catalogueIdentity("movie", item.providerIds) == null
    "series" -> catalogueIdentity("series", item.providerIds) == null || item.name.isBlank()
    "episode", "season" -> item.seriesId.isNullOrBlank()
    else -> true
  }
  if (needsItem) item = readItem(api, data.libraryId, item.id) ?: item

  when (item.type) {
    "series" -> {
      if (seriesName == null) seriesName = item.name.takeIf { it.isNotBlank() }
      if (seriesIds == null) seriesIds = item.providerIds.takeIf { catalogueIdentity("series", it) != null }
    }
    "episode", "season" -> {
      val parentId = item.seriesId?.takeIf { it.isNotBlank() }
      // A caller-provided hint cannot prove that it belongs to this episode. Once the provider
      // names its series id, that parent is the only authoritative source for the show identity.
      if (parentId != null) {
        val parent = readItem(api, data.libraryId, parentId)
        if (parent?.type == "series") {
          seriesName = parent.name.takeIf { it.isNotBlank() } ?: seriesName
          seriesIds = parent.providerIds.takeIf { catalogueIdentity("series", it) != null } ?: hintedSeriesIds
        } else if (parent != null) {
          seriesIds = null
          seriesName = item.seriesName?.takeIf { it.isNotBlank() }
        }
      } else {
        seriesIds = hintedSeriesIds
        seriesName = hintedSeriesName ?: item.seriesName?.takeIf { it.isNotBlank() }
      }
    }
  }
  return RemoteMetadata(item, seriesName, seriesIds)
}

private suspend fun readItem(api: RemoteLibraryApi, libraryId: String, itemId: String): RemoteItemDto? =
  try {
    api.remoteItem(libraryId, itemId).item.also { currentCoroutineContext().ensureActive() }
  } catch (cancelled: CancellationException) {
    throw cancelled
  } catch (_: ApiError) {
    null
  }
