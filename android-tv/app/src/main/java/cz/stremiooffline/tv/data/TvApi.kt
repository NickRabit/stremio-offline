package cz.stremiooffline.tv.data

import cz.stremiooffline.tv.playback.PlaybackApi
import okhttp3.OkHttpClient

/** The library browse and paging one screen needs. */
interface LibraryApi {
  suspend fun browse(path: String?, limit: Int = 60, skip: Int = 0): BrowseResult
}

/** The one merged Favourites list: library stars and catalogue stars in one page. */
interface FavoritesApi {
  suspend fun favorites(filter: FavoriteFilter = FavoriteFilter.All, limit: Int = 60, skip: Int = 0): FavoritesPage
}

/** The one merged Continue watching list: Home's resume row paged and filtered, plus the forget
 *  that drops every stored key one card stands for. */
interface ResumeApi {
  suspend fun resume(filter: ResumeFilter = ResumeFilter.All, limit: Int = 60, skip: Int = 0): ResumePage

  /** Forgets the stored positions behind every key, the way the web's Home card does. */
  suspend fun forgetProgress(keys: List<String>)
}

/** What the title detail needs: the stored position and the library star. */
interface DetailApi {
  suspend fun progress(key: String): ProgressDto?

  suspend fun setFavorite(path: String, favorite: Boolean): FavoriteToggleDto
}

/** The catalogue calls: browse, search, metadata, streams, the watchlist and To library. */
interface CatalogApi {
  suspend fun catalogs(): List<CatalogDto>
  /** The libraries this account may see, each carrying whether it may queue a download there. */
  suspend fun libraries(): List<LibraryDto>
  suspend fun catalog(addonKey: String, type: String, id: String, skip: Int, genre: String?): List<MetaDto>
  /** The catalogues search can be scoped to, as `GET /api/searchable` lists them. */
  suspend fun searchable(): List<SearchableCatalogDto>
  suspend fun search(query: String, cursor: String?, scope: SearchScope): SearchResultDto
  /** The account's recent searches and whether the server keeps them. */
  suspend fun searchState(): SearchStateDto
  /** Records one committed query; the server trims, dedupes and ignores it while saving is off. */
  suspend fun recordSearch(query: String)
  /** Drops one query from the history, answering the state that is left. */
  suspend fun forgetSearch(query: String): SearchStateDto
  /** Empties the history, answering the state that is left. */
  suspend fun clearSearchHistory(): SearchStateDto
  suspend fun meta(type: String, id: String, language: String?): MetaDto
  suspend fun streamSources(type: String, id: String): List<StreamSourceDto>
  suspend fun streams(type: String, id: String, addon: String? = null): List<StreamDto>
  /** The viewer's own library copies of one title or episode (`GET /api/local-streams`). */
  suspend fun localStreams(type: String, id: String): List<StreamDto>
  suspend fun addons(): List<AddonDto>
  suspend fun settings(): SettingsResponse
  /** The content languages `GET /api/languages` offers, codes only. */
  suspend fun languages(): List<LanguageDto>
  /** Writes exactly one personal preference; the server refuses an instance key in the body. */
  suspend fun updateSettings(field: String, value: String): SettingsResponse
  /** Writes the whole personal Home arrangement, or clears it with a `null`. */
  suspend fun updateHomeLayout(layout: HomeLayoutDto?): SettingsResponse
  suspend fun progressList(): List<ProgressEntryDto>
  suspend fun watchlist(): List<WatchlistEntryDto>
  suspend fun setWatchlist(type: String, id: String, name: String, poster: String?, favorite: Boolean): WatchlistToggleDto
  /** Queues one source; [target] names the library the viewer picked, or is null to let the
   *  server pick the addon's own default. */
  suspend fun download(title: String, sourceId: String, media: MediaDto, target: DownloadTargetDto? = null): DownloadResult
  /** Queues a whole series at once; each episode picks its own source when it downloads. */
  suspend fun downloadBulk(
    title: String,
    type: String,
    episodes: List<BulkEpisodeDto>,
    selection: DownloadSelectionDto,
    media: BulkMediaDto,
    target: DownloadTargetDto? = null,
  ): BulkDownloadResult
}

/** The Home rows, asked by name so a retry touches only the row it names. */
interface HomeApi {
  suspend fun home(rows: List<String>): HomeResponseDto
  /** Every Home row the account may arrange, with its own order, hidden rows and feeds. */
  suspend fun homeLayout(): HomeLayoutResponseDto
}

/** The account's download queue, read for the Home summary. */
interface DownloadsApi {
  suspend fun downloads(): DownloadsResponseDto
}

/**
 * The read-only media-server libraries this account may browse, every identifier opaque and
 * round-tripped exactly as the server minted it. A method carries no path, URL or credential: the
 * local server is the only thing that ever talks to the provider.
 *
 * Every method defaults to a [ApiError] so an existing test double still compiles; a default that
 * silently answered empty would let a screen present "nothing" for a call that was never made.
 * [ApiClient] overrides each with the real request.
 */
interface RemoteLibraryApi {
  suspend fun remoteLibraries(): List<RemoteLibraryDto> = throw ApiError(ApiFailure.Generic)

  suspend fun remoteItems(
    libraryId: String,
    limit: Int = 100,
    cursor: String? = null,
    search: String? = null,
    type: String? = null,
  ): RemoteItemsPageDto = throw ApiError(ApiFailure.Generic)

  /**
   * One lazy page of a remote directory: the attached library root ([parentId] null) or one folder
   * inside it. The server pages, filters and sorts; nothing is scanned ahead.
   */
  suspend fun remoteBrowse(
    libraryId: String,
    limit: Int = 60,
    cursor: String? = null,
    search: String? = null,
    type: String? = null,
    parentId: String? = null,
    mode: String? = null,
    sort: String? = null,
    order: String? = null,
  ): RemoteItemsPageDto = throw ApiError(ApiFailure.Generic)

  /** Up to four same-origin authorized poster URLs for one library root or folder; empty when the
   *  library's mosaic is off or the directory has no artwork of its own. */
  suspend fun remotePreview(libraryId: String, parentId: String? = null): RemotePreviewDto =
    throw ApiError(ApiFailure.Generic)

  suspend fun remoteItem(libraryId: String, itemId: String): RemoteItemDetailDto =
    throw ApiError(ApiFailure.Generic)

  suspend fun remoteEpisodes(
    libraryId: String,
    itemId: String,
    limit: Int = 100,
    cursor: String? = null,
  ): RemoteItemsPageDto = throw ApiError(ApiFailure.Generic)

  suspend fun remoteSources(libraryId: String, itemId: String): List<StreamDto> =
    throw ApiError(ApiFailure.Generic)

  suspend fun remoteItemState(libraryId: String, itemId: String): RemoteItemStateDto =
    throw ApiError(ApiFailure.Generic)

  suspend fun patchRemoteItemState(
    libraryId: String,
    itemId: String,
    patch: RemoteItemStatePatch,
  ): RemoteItemStateDto = throw ApiError(ApiFailure.Generic)

  /**
   * The remote versions of one catalogue title or episode, matched by external id only.
   * [nameHint] is the resolved catalogue title of the title being opened -- a series name for an
   * episode, never the episode's own -- and is sent only as the provider's supported name filter.
   */
  suspend fun remoteMatchedStreams(libraryId: String, type: String, catalogId: String, nameHint: String? = null): List<StreamDto> =
    throw ApiError(ApiFailure.Generic)

  /** One page of the remote personal lists; [filter] is `favorites` or `resume`. */
  suspend fun remotePersonal(filter: String, skip: Int = 0, limit: Int = 40): RemotePersonalPage =
    throw ApiError(ApiFailure.Generic)
}

/** Everything a signed-in screen does: library, detail, catalogue, Home, images and playback. */
interface TvApi : LibraryApi, FavoritesApi, ResumeApi, DetailApi, PlaybackApi, CatalogApi, HomeApi, DownloadsApi, RemoteLibraryApi {
  val http: OkHttpClient
  /** The address as the user typed it, shown on the Settings screen. */
  val serverAddress: String
  fun url(path: String): String
  /** The server's own version from `/api/status`. */
  suspend fun serverVersion(): String
  suspend fun librarySource(path: String): SourceDto

  /** The catalogue title the library file at [path] is bound to (`GET /api/library/title`), or
   *  null when it has no binding, the path names nothing this account may see, or the call
   *  failed. Either way the file offers no addon sources. */
  suspend fun libraryTitle(path: String): LibraryTitleDto?

  /** The addon subtitles offered for one catalogue title or episode. */
  suspend fun subtitles(type: String, id: String): List<AddonSubtitleDto>

  /** One subtitle as WebVTT, shifted by `offset` and `delay` the way the web asks for it. */
  suspend fun subtitleText(id: String, offset: Double, delay: Double): String?

  /** The next library file after this source, or null when there is none. */
  suspend fun libraryNext(sourceId: String): NextFileDto?

  /** One poll of the sidecar URL the descriptor named, at the current position and delay. */
  suspend fun sidecar(url: String, position: Double, delay: Double): SidecarFetch?

  /** One rate-limited line for the server's log; best effort, so a failure is swallowed. */
  suspend fun clientLog(level: String, message: String, context: Map<String, String>? = null)

  /** Uploads the app's diagnostics bundle; answers the id the server filed it under. */
  suspend fun sendClientLogBundle(bundle: ClientLogBundleDto): String
}
