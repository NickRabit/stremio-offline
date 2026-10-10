package cz.stremiooffline.tv.ui

import cz.stremiooffline.tv.data.AddonDto
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.BrowseResult
import cz.stremiooffline.tv.data.CatalogDto
import cz.stremiooffline.tv.data.ClientCapabilitiesDto
import cz.stremiooffline.tv.data.DownloadResult
import cz.stremiooffline.tv.data.MediaDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.ProgressEntryDto
import cz.stremiooffline.tv.data.SearchResultDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.SourceDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.data.WatchlistEntryDto
import cz.stremiooffline.tv.data.WatchlistToggleDto
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import java.util.concurrent.CountDownLatch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient

/** A `TvApi` that answers from memory, so a screen can be tested without a server. */
open class FakeTvApi : TvApi {
  var pages: MutableMap<String?, BrowseResult> = mutableMapOf()
  var progressValues: MutableMap<String, ProgressDto> = mutableMapOf()
  var browseCalls: MutableList<Pair<String?, Int>> = mutableListOf()
  var failBrowse = false

  var catalogsValue: List<CatalogDto> = emptyList()
  var catalogPages: MutableMap<String, List<List<MetaDto>>> = mutableMapOf()
  var catalogRequests: MutableList<CatalogRequest> = mutableListOf()
  var failCatalogs = false
  var failCatalog = false
  var metaValues: MutableMap<String, MetaDto> = mutableMapOf()
  var streamsValues: MutableMap<String, List<StreamDto>> = mutableMapOf()
  var streamsRequests: MutableList<String> = mutableListOf()
  /** A latch keyed by `type:id` blocks a `streams()` call like a slow server would. */
  var streamsLatches: MutableMap<String, CountDownLatch> = mutableMapOf()
  var streamFailures: MutableMap<String, ApiFailure> = mutableMapOf()
  var addonsValue: List<AddonDto> = emptyList()
  var settingsValue: SettingsResponse = SettingsResponse()
  var progressEntries: List<ProgressEntryDto> = emptyList()
  var watchlistValue: MutableList<WatchlistEntryDto> = mutableListOf()
  var favoriteCalls: MutableList<Triple<String, String, Boolean>> = mutableListOf()
  var watchlistLatch: CountDownLatch? = null
  var watchlistFailure: ApiFailure? = null
  var watchlistAnswer: ((Boolean) -> Boolean)? = null
  var downloads: MutableList<Pair<String?, MediaDto>> = mutableListOf()
  var downloadResult: DownloadResult = DownloadResult(status = "queued")
  var downloadFailure: ApiFailure? = null
  var searchPages: MutableMap<String, SearchResultDto> = mutableMapOf()
  var searchRequests: MutableList<Pair<String, String?>> = mutableListOf()
  var failSearch = false

  override val http: OkHttpClient = OkHttpClient()

  override fun url(path: String): String = "http://server$path"

  override suspend fun browse(path: String?, limit: Int, skip: Int): BrowseResult {
    browseCalls += path to skip
    if (failBrowse) throw ApiError(ApiFailure.Generic)
    return pages[path] ?: BrowseResult(path.orEmpty(), emptyList(), 0, false)
  }

  override suspend fun librarySource(path: String): SourceDto = SourceDto(sourceId = "src:$path")

  override suspend fun progress(key: String): ProgressDto? = progressValues[key]

  override suspend fun catalogs(): List<CatalogDto> {
    if (failCatalogs) throw ApiError(ApiFailure.Generic)
    return catalogsValue
  }

  override suspend fun catalog(addonKey: String, type: String, id: String, skip: Int, genre: String?): List<MetaDto> {
    catalogRequests += CatalogRequest(addonKey, type, id, skip, genre)
    if (failCatalog) throw ApiError(ApiFailure.Generic)
    val pages = catalogPages[addonKey].orEmpty()
    var offset = 0
    for (page in pages) {
      if (offset == skip) return page
      offset += page.size
    }
    return emptyList()
  }

  override suspend fun search(query: String, cursor: String?): SearchResultDto {
    searchRequests += query to cursor
    if (failSearch) throw ApiError(ApiFailure.Generic)
    return searchPages[cursor ?: ""] ?: SearchResultDto()
  }

  override suspend fun meta(type: String, id: String, language: String?): MetaDto =
    metaValues["$type:$id"] ?: throw ApiError(ApiFailure.NotFound)

  override suspend fun streams(type: String, id: String): List<StreamDto> {
    val key = "$type:$id"
    streamsRequests += key
    // A blocking wait inside the IO context, like the real client: the coroutine is cancelled, but
    // the call still runs to completion before the cancellation is delivered.
    streamsLatches[key]?.let { latch -> withContext(Dispatchers.IO) { latch.await() } }
    streamFailures[key]?.let { throw ApiError(it) }
    return streamsValues[key] ?: emptyList()
  }

  override suspend fun addons(): List<AddonDto> = addonsValue

  override suspend fun settings(): SettingsResponse = settingsValue

  override suspend fun progressList(): List<ProgressEntryDto> = progressEntries

  override suspend fun watchlist(): List<WatchlistEntryDto> = watchlistValue

  override suspend fun setWatchlist(
    type: String,
    id: String,
    name: String,
    poster: String?,
    favorite: Boolean,
  ): WatchlistToggleDto {
    favoriteCalls += Triple(type, id, favorite)
    watchlistLatch?.let { latch -> withContext(Dispatchers.IO) { latch.await() } }
    watchlistFailure?.let { throw ApiError(it) }
    return WatchlistToggleDto("$type:$id", watchlistAnswer?.invoke(favorite) ?: favorite)
  }

  override suspend fun download(title: String, sourceId: String, media: MediaDto): DownloadResult {
    downloadFailure?.let { throw ApiError(it) }
    downloads += title to media
    return downloadResult
  }

  override suspend fun startPlayback(sourceId: String, capabilities: ClientCapabilitiesDto, time: Double): PlaybackDescriptorDto =
    PlaybackDescriptorDto(id = "p1", url = "stream.mp4")

  override suspend fun seekPlayback(id: String, time: Double): PlaybackDescriptorDto =
    PlaybackDescriptorDto(id = id, url = "stream.m3u8", playlist = true, offset = time)

  override suspend fun escalatePlayback(id: String, time: Double): PlaybackDescriptorDto =
    PlaybackDescriptorDto(id = id, url = "escalated.m3u8", playlist = true, offset = time)

  override suspend fun pingPlayback(id: String) {}

  override suspend fun deletePlayback(id: String) {}

  override suspend fun saveProgress(key: String, position: Double, duration: Double, title: String, path: String?) {}
}

data class CatalogRequest(val addonKey: String, val type: String, val id: String, val skip: Int, val genre: String?)

fun file(
  path: String,
  label: String = path.substringAfterLast('/'),
  season: Int? = null,
  episode: Int? = null,
  progress: ProgressDto? = null,
): BrowseItem.File = BrowseItem.File(
  path = path,
  label = label,
  season = season,
  episode = episode,
  progress = progress,
)

fun progress(position: Double, duration: Double): ProgressDto = ProgressDto(position, duration)
