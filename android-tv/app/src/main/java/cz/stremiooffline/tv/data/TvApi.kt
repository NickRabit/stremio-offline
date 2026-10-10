package cz.stremiooffline.tv.data

import cz.stremiooffline.tv.playback.PlaybackApi
import okhttp3.OkHttpClient

/** The library browse and paging one screen needs. */
interface LibraryApi {
  suspend fun browse(path: String?, limit: Int = 60, skip: Int = 0): BrowseResult
}

/** What the title detail needs to refresh a stored position. */
interface DetailApi {
  suspend fun progress(key: String): ProgressDto?
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
}
