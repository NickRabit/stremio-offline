package cz.stremiooffline.tv.ui.catalog

import cz.stremiooffline.tv.catalog.Streams
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteItemStateDto
import cz.stremiooffline.tv.data.RemoteItemStatePatch
import cz.stremiooffline.tv.data.RemoteLibraryApi
import cz.stremiooffline.tv.data.RemoteProviderIdsDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.playback.Progress
import kotlinx.coroutines.CancellationException

data class RemoteEpisodes(
  val videos: List<VideoDto>,
  val resume: List<HomeCard.Remote>,
)

/** Where a detail's own data and actions come from, as the web's CatalogueTitleDetail,
 *  LocalLibraryDetail and RemoteLibraryBrowser feed LibraryTitleDetail. */
interface TitleBackend {
  /** Addon sources, media-server matches, ratings/cast/trailers, watchlist and the catalogue's
   *  own progress are asked only for a catalogue title. */
  val catalogue: Boolean

  /** The rows this backend owns for one video (the meta id for a film); null = catalogue lookup. */
  suspend fun ownRows(api: TvApi, videoId: String): List<StreamDto>?

  /** The star's first state; null = the catalogue watchlist decides. */
  suspend fun favourite(api: TvApi): Boolean?

  /** Stars or unstars; null = the catalogue watchlist does it. */
  suspend fun setFavourite(api: TvApi, wanted: Boolean): Boolean?

  /** Watched / Unwatched for the active row; false = not handled. */
  suspend fun markWatched(
    api: TvApi,
    active: StreamDto?,
    title: String,
    poster: String?,
  ): Boolean

  suspend fun forget(api: TvApi, active: StreamDto?): Boolean

  /** The positions available when the detail opens. */
  suspend fun initialEpisodeProgress(api: TvApi): Map<String, ProgressDto>

  /** Each episode's stored position for its card; empty = the catalogue's own progress marks. */
  suspend fun episodeProgress(api: TvApi): Map<String, ProgressDto>

  /** Whether To library is offered for [active], and the action when it is; null = the catalogue's. */
  fun toLibrary(active: StreamDto?): LibraryCopy?

  /** Reads the episodes a remote series did not carry when its detail opened. */
  suspend fun loadEpisodes(api: TvApi): RemoteEpisodes? = null
}

internal object CatalogueBackend : TitleBackend {
  override val catalogue = true
  override suspend fun ownRows(api: TvApi, videoId: String): List<StreamDto>? = null
  override suspend fun favourite(api: TvApi): Boolean? = null
  override suspend fun setFavourite(api: TvApi, wanted: Boolean): Boolean? = null
  override suspend fun markWatched(
    api: TvApi,
    active: StreamDto?,
    title: String,
    poster: String?,
  ): Boolean = false
  override suspend fun forget(api: TvApi, active: StreamDto?): Boolean = false
  override suspend fun initialEpisodeProgress(api: TvApi): Map<String, ProgressDto> = emptyMap()
  override suspend fun episodeProgress(api: TvApi): Map<String, ProgressDto> = emptyMap()
  override fun toLibrary(active: StreamDto?): LibraryCopy? = null
}

internal class LibraryBackend(
  val rows: Map<String, List<StreamDto>>,
  val favouritePath: String,
  val favourite: Boolean,
  val progress: Map<String, ProgressDto> = emptyMap(),
) : TitleBackend {
  override val catalogue = false

  override suspend fun ownRows(api: TvApi, videoId: String): List<StreamDto> = rows[videoId].orEmpty()

  override suspend fun favourite(api: TvApi): Boolean = favourite

  override suspend fun setFavourite(api: TvApi, wanted: Boolean): Boolean =
    api.setFavorite(favouritePath, wanted).favorite

  override suspend fun markWatched(
    api: TvApi,
    active: StreamDto?,
    title: String,
    poster: String?,
  ): Boolean {
    val path = active?.takeIf(Streams::isLocalStream)?.localPath?.takeIf { it.isNotBlank() } ?: return false
    api.saveProgress(Progress.libraryKey(path), 1.0, 1.0, title, path, poster, null, null, final = true)
    return true
  }

  override suspend fun forget(api: TvApi, active: StreamDto?): Boolean {
    val path = active?.takeIf(Streams::isLocalStream)?.localPath?.takeIf { it.isNotBlank() } ?: return false
    api.forgetProgress(listOf(Progress.libraryKey(path)))
    return true
  }

  override suspend fun initialEpisodeProgress(api: TvApi): Map<String, ProgressDto> = progress

  override suspend fun episodeProgress(api: TvApi): Map<String, ProgressDto> =
    refreshedOwnProgress(api, this, progress)

  override fun toLibrary(active: StreamDto?): LibraryCopy? = null
}

internal class RemoteBackend(
  val libraryId: String,
  val libraryName: String,
  val provider: String,
  val item: RemoteItemDto,
  episodes: List<RemoteItemDto> = emptyList(),
  private val resume: List<HomeCard.Remote> = emptyList(),
  val seriesName: String? = item.seriesName ?: item.name.takeIf { item.type == "series" },
  val seriesIds: RemoteProviderIdsDto? = item.providerIds.takeIf { catalogueIdentity("series", it) != null },
) : TitleBackend {
  override val catalogue = false

  private var state: RemoteItemStateDto? = null
  private var episodeItems = episodes

  private fun episodeId(videoId: String): String? =
    episodeItems.firstOrNull { remoteVideoId(libraryId, it.id) == videoId }?.id

  override suspend fun ownRows(api: TvApi, videoId: String): List<StreamDto> {
    val itemId = when {
      item.type == "movie" -> item.id
      episodeItems.isNotEmpty() -> episodeId(videoId)
      videoId == remoteMetaId(libraryId, item.id) -> item.id
      else -> null
    }
    return itemId?.let { remoteRows(api, libraryId, it) }.orEmpty()
  }

  override suspend fun favourite(api: TvApi): Boolean? =
    try {
      api.remoteItemState(libraryId, item.id).also { state = it }.favorite
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      null
    }

  override suspend fun setFavourite(api: TvApi, wanted: Boolean): Boolean =
    api.patchRemoteItemState(libraryId, item.id, RemoteItemStatePatch(favorite = wanted))
      .also { state = it }
      .favorite

  private fun activeItemId(active: StreamDto?): String =
    active?.remoteItem?.takeIf { it.libraryId == libraryId }?.itemId?.takeIf { it.isNotBlank() }
      ?: item.id

  override suspend fun markWatched(
    api: TvApi,
    active: StreamDto?,
    title: String,
    poster: String?,
  ): Boolean {
    state = api.patchRemoteItemState(
      libraryId,
      activeItemId(active),
      RemoteItemStatePatch(watched = true),
    )
    return true
  }

  override suspend fun forget(api: TvApi, active: StreamDto?): Boolean {
    val itemId = activeItemId(active)
    val current = try {
      api.remoteItemState(libraryId, itemId)
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      state
    }
    state = api.patchRemoteItemState(
      libraryId,
      itemId,
      RemoteItemStatePatch(
        position = 0.0,
        duration = 0.0,
        final = true,
        watched = false.takeIf { current?.watched == true },
      ),
    )
    return true
  }

  override suspend fun initialEpisodeProgress(api: TvApi): Map<String, ProgressDto> = episodeProgress(api)

  override suspend fun episodeProgress(api: TvApi): Map<String, ProgressDto> {
    if (item.type != "series") return emptyMap()
    val cards = try {
      remoteResumeCards(api, libraryId)
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      resume.filter { it.libraryId == libraryId }
    }
    val known = episodeItems.mapTo(HashSet()) { it.id }
    return cards.mapNotNull { card ->
      if (card.itemType != "episode" || card.itemId !in known) return@mapNotNull null
      val progress = card.progress ?: return@mapNotNull null
      remoteVideoId(libraryId, card.itemId) to ProgressDto(progress.position, progress.duration)
    }.toMap()
  }

  override fun toLibrary(active: StreamDto?): LibraryCopy? = when (item.type) {
    "movie" -> active
      ?.takeIf { it.remoteItem?.libraryId == libraryId && Streams.canQueue(it, false) }
      ?.let {
        LibraryCopy.Native(
          libraryId = libraryId,
          item = item,
          seriesName = seriesName,
          seriesIds = seriesIds,
          sources = listOf(it),
        )
      }
    "series" -> LibraryCopy.Series(
      origin = BulkOrigin.Remote(libraryId, libraryName, provider, item.id),
      title = seriesName ?: item.name,
      selected = active?.remoteItem?.itemId
        ?.let { id -> episodeItems.firstOrNull { it.id == id } }
        ?.let {
          LibraryCopy.Native(
            libraryId = libraryId,
            item = it,
            seriesName = seriesName,
            seriesIds = seriesIds,
            sources = null,
          )
        },
    )
    else -> null
  }

  override suspend fun loadEpisodes(api: TvApi): RemoteEpisodes? {
    if (item.type != "series") return null
    val found = remoteEpisodeList(api, libraryId, item.id)
    episodeItems = found
    if (found.isEmpty()) return RemoteEpisodes(emptyList(), resume)
    val cards = try {
      remoteResumeCards(api, libraryId)
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      resume.filter { it.libraryId == libraryId }
    }
    return RemoteEpisodes(
      videos = found.map { episode ->
        VideoDto(
          id = remoteVideoId(libraryId, episode.id),
          title = episode.name,
          season = episode.season,
          episode = episode.episode,
          overview = episode.overview,
          thumbnail = episode.wide ?: episode.poster,
        )
      },
      resume = cards,
    )
  }
}

sealed interface LibraryCopy {
  data class Native(
    val libraryId: String,
    val item: RemoteItemDto,
    val seriesName: String?,
    val seriesIds: RemoteProviderIdsDto?,
    val sources: List<StreamDto>?,
  ) : LibraryCopy

  data class Series(
    val origin: BulkOrigin.Remote,
    val title: String,
    val selected: Native?,
  ) : LibraryCopy
}

internal fun remoteMetaId(libraryId: String, itemId: String): String = "remote:$libraryId:$itemId"

internal fun remoteVideoId(libraryId: String, episodeId: String): String =
  remoteMetaId(libraryId, episodeId)

/** Reads one item's versions with the old detail's remote-only filter. */
internal suspend fun remoteRows(
  api: RemoteLibraryApi,
  libraryId: String,
  itemId: String,
): List<StreamDto> =
  api.remoteSources(libraryId, itemId).filter(Streams::isRemoteStream)

/** Every episode page the detail is allowed to read, following the provider cursor. */
internal suspend fun remoteEpisodeList(
  api: RemoteLibraryApi,
  libraryId: String,
  seriesId: String,
  maxPages: Int = 20,
): List<RemoteItemDto> {
  val found = ArrayList<RemoteItemDto>()
  var cursor: String? = null
  repeat(maxPages) {
    val page = api.remoteEpisodes(libraryId, seriesId, cursor = cursor)
    found += page.items
    cursor = page.cursor?.takeIf { it.isNotBlank() } ?: return found.distinctBy { it.id }
  }
  return found.distinctBy { it.id }
}

internal suspend fun remoteResumeCards(
  api: RemoteLibraryApi,
  libraryId: String,
): List<HomeCard.Remote> =
  api.remotePersonal("resume", 0, 60).items
    .filterIsInstance<HomeCard.Remote>()
    .filter { it.libraryId == libraryId }

internal fun ownEpisodeProgress(progress: Map<String, ProgressDto>, videoId: String?): Float? =
  progress[videoId]?.takeIf { it.duration > 0 && it.position > 0 }
    ?.let { (it.position / it.duration).toFloat() }

internal fun ownEpisodeCompleted(progress: Map<String, ProgressDto>, videoId: String?): Boolean =
  progress[videoId]?.let { Progress.isCompleted(it.position, it.duration) } == true

/** Every episode's position read again under its file's key; a failed read keeps the old one. */
internal suspend fun refreshedOwnProgress(
  api: TvApi,
  own: LibraryBackend,
  before: Map<String, ProgressDto>,
): Map<String, ProgressDto> {
  val next = HashMap<String, ProgressDto>()
  for ((videoId, rows) in own.rows) {
    val path = rows.firstOrNull()?.localPath?.takeIf { it.isNotBlank() } ?: continue
    val read = try {
      api.progress(Progress.libraryKey(path))
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      before[videoId]
    }
    if (read != null) next[videoId] = read
  }
  return next
}

/** Resolves one media-server copy through the old detail's exact subject, versions and rules. */
internal suspend fun resolveLibraryCopy(api: TvApi, copy: LibraryCopy.Native): NativeCopyRequest =
  resolveNativeCopy(
    api = api,
    libraryId = copy.libraryId,
    item = copy.item,
    seriesName = copy.seriesName,
    seriesIds = copy.seriesIds,
    sources = copy.sources,
    loadDestinations = api::libraries,
  )
