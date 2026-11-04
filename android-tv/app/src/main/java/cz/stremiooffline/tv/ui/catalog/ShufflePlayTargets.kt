package cz.stremiooffline.tv.ui.catalog

import cz.stremiooffline.tv.catalog.ProgressKey
import cz.stremiooffline.tv.catalog.Streams
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.ShuffleItemDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.playback.Progress
import cz.stremiooffline.tv.ui.detail.PlayTarget
import cz.stremiooffline.tv.ui.detail.RemoteDetailData
import cz.stremiooffline.tv.ui.detail.ShuffleRun
import cz.stremiooffline.tv.ui.detail.resolveRemoteMetadata
import kotlinx.coroutines.CancellationException

internal suspend fun remoteShufflePlayTarget(
  api: TvApi,
  item: ShuffleItemDto,
  shuffle: ShuffleRun,
): PlayTarget? {
  val shuffled = item.remote ?: return null
  val streams = api.remoteSources(shuffled.libraryId, shuffled.itemId)
  val stream = streams.firstOrNull { it.playable } ?: return null
  val remoteItem = stream.remoteItem ?: return null
  val metadata = resolveRemoteMetadata(
    api,
    RemoteDetailData(
      libraryId = shuffled.libraryId,
      libraryName = stream.libraryName.orEmpty(),
      provider = stream.provider.orEmpty(),
      item = RemoteItemDto(id = shuffled.itemId),
    ),
  )
  val identity = nativeAddonIdentity(metadata.item, metadata.seriesIds)
  return PlayTarget(
    key = identity?.let { ProgressKey.of(it.first, it.second) } ?: remoteItem.progressKey,
    title = item.title.ifBlank { metadata.item.name },
    resume = false,
    sourceId = stream.sourceId.takeIf { it.isNotBlank() },
    stableKey = stream.stableKey,
    poster = metadata.item.poster ?: metadata.seriesPoster,
    addonKey = stream.addonKey,
    subtitleType = identity?.first,
    subtitleTarget = identity?.second,
    subtitleName = metadata.seriesName ?: metadata.item.name,
    remoteItem = remoteItem,
    remoteSources = Streams.remoteVersionsOf(remoteItem, streams),
    initialSources = streams,
    shuffle = shuffle,
  )
}

internal suspend fun localShufflePlayTarget(
  api: TvApi,
  item: ShuffleItemDto,
  shuffle: ShuffleRun,
  poster: String? = null,
): PlayTarget? {
  val path = item.path ?: return null
  val binding = try {
    api.libraryTitle(path)
  } catch (cancelled: CancellationException) {
    throw cancelled
  } catch (_: Exception) {
    null
  }
  val identity = libraryAddonIdentity(binding)
  val artwork = poster ?: run {
    val parent = path.substringBeforeLast('/', "")
    val page = try {
      api.browse(parent.takeIf { it.isNotEmpty() }, limit = 20, query = path.substringAfterLast('/'))
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: Exception) {
      null
    }
    page?.items?.filterIsInstance<BrowseItem.File>()
      ?.firstOrNull { it.path == path }
      ?.let { it.poster ?: it.wide }
  }
  return PlayTarget(
    key = Progress.libraryKey(path),
    title = item.title,
    resume = false,
    path = path,
    poster = artwork,
    subtitleType = identity?.first,
    subtitleTarget = identity?.second,
    subtitleName = binding?.name,
    initialSources = listOf(
      StreamDto(
        sourceId = Progress.libraryKey(path),
        kind = "library",
        playable = true,
        localPath = path,
      ),
    ),
    shuffle = shuffle,
  )
}
