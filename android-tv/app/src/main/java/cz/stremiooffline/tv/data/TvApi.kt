package cz.stremiooffline.tv.data

import cz.stremiooffline.tv.playback.PlaybackApi
import okhttp3.OkHttpClient

/** The library browse and paging one screen needs. */
interface LibraryApi {
  suspend fun browse(path: String?, limit: Int = 60, skip: Int = 0): BrowseResult

  /** The library's Favourites view (`GET /api/library/favorites`). */
  suspend fun favorites(limit: Int = 60, skip: Int = 0): BrowseResult
}

/** What the title detail needs: the stored position and the library star. */
interface DetailApi {
  suspend fun progress(key: String): ProgressDto?

  suspend fun setFavorite(path: String, favorite: Boolean): FavoriteToggleDto
}

/** The catalogue calls: browse, search, metadata, streams, the watchlist and To library. */
interface CatalogApi {
  suspend fun catalogs(): List<CatalogDto>
  suspend fun catalog(addonKey: String, type: String, id: String, skip: Int, genre: String?): List<MetaDto>
  suspend fun search(query: String, cursor: String?): SearchResultDto
  suspend fun meta(type: String, id: String, language: String?): MetaDto
  suspend fun streamSources(type: String, id: String): List<StreamSourceDto>
  suspend fun streams(type: String, id: String, addon: String? = null): List<StreamDto>
  suspend fun addons(): List<AddonDto>
  suspend fun settings(): SettingsResponse
  suspend fun progressList(): List<ProgressEntryDto>
  suspend fun watchlist(): List<WatchlistEntryDto>
  suspend fun setWatchlist(type: String, id: String, name: String, poster: String?, favorite: Boolean): WatchlistToggleDto
  suspend fun download(title: String, sourceId: String, media: MediaDto): DownloadResult
}

/** The Home rows, asked by name so a retry touches only the row it names. */
interface HomeApi {
  suspend fun home(rows: List<String>): HomeResponseDto
}

/** The account's download queue, read for the Home summary. */
interface DownloadsApi {
  suspend fun downloads(): DownloadsResponseDto
}

/** Everything a signed-in screen does: library, detail, catalogue, Home, images and playback. */
interface TvApi : LibraryApi, DetailApi, PlaybackApi, CatalogApi, HomeApi, DownloadsApi {
  val http: OkHttpClient
  fun url(path: String): String
  suspend fun librarySource(path: String): SourceDto

  /** The addon subtitles offered for one catalogue title or episode. */
  suspend fun subtitles(type: String, id: String): List<AddonSubtitleDto>

  /** One subtitle as WebVTT, shifted by `offset` and `delay` the way the web asks for it. */
  suspend fun subtitleText(id: String, offset: Double, delay: Double): String?

  /** The next library file after this source, or null when there is none. */
  suspend fun libraryNext(sourceId: String): NextFileDto?

  /** One poll of the sidecar URL the descriptor named, at the current position and delay. */
  suspend fun sidecar(url: String, position: Double, delay: Double): SidecarFetch?
}
