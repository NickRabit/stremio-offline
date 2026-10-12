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

/** Everything a signed-in screen does: library, detail, catalogue, Home, images and playback. */
interface TvApi : LibraryApi, FavoritesApi, ResumeApi, DetailApi, PlaybackApi, CatalogApi, HomeApi, DownloadsApi {
  val http: OkHttpClient
  /** The address as the user typed it, shown on the Settings screen. */
  val serverAddress: String
  fun url(path: String): String
  /** The server's own version from `/api/status`. */
  suspend fun serverVersion(): String
  suspend fun librarySource(path: String): SourceDto

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
