package cz.stremiooffline.tv.ui

import cz.stremiooffline.tv.data.AddonDto
import cz.stremiooffline.tv.data.AddonSubtitleDto
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.BrowseResult
import cz.stremiooffline.tv.data.CatalogDto
import cz.stremiooffline.tv.data.ClientLogBundleDto
import cz.stremiooffline.tv.data.ClientCapabilitiesDto
import cz.stremiooffline.tv.data.CopyDto
import cz.stremiooffline.tv.data.DownloadResult
import cz.stremiooffline.tv.data.DownloadTargetDto
import cz.stremiooffline.tv.data.DownloadsResponseDto
import cz.stremiooffline.tv.data.FavoriteToggleDto
import cz.stremiooffline.tv.data.HomeResponseDto
import cz.stremiooffline.tv.data.HomeLayoutDto
import cz.stremiooffline.tv.data.HomeLayoutResponseDto
import cz.stremiooffline.tv.data.LanguageDto
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.MediaDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.NextFileDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.ProgressEntryDto
import cz.stremiooffline.tv.data.SearchResultDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.SidecarFetch
import cz.stremiooffline.tv.data.SourceDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.StreamSourceDto
import cz.stremiooffline.tv.data.TrackChange
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.data.WatchlistEntryDto
import cz.stremiooffline.tv.data.WatchlistToggleDto
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient

/** A `TvApi` that answers from memory, so a screen can be tested without a server. */
open class FakeTvApi : TvApi {
  var pages: MutableMap<String?, BrowseResult> = mutableMapOf()
  var progressValues: MutableMap<String, ProgressDto> = mutableMapOf()
  var browseCalls: MutableList<Pair<String?, Int>> = mutableListOf()
  var failBrowse = false
  var favoritesValue: BrowseResult = BrowseResult(":favorites", emptyList(), 0, false)
  var favoritesCalls: MutableList<Int> = mutableListOf()
  var failFavorites = false
  var libraryFavoriteCalls: MutableList<Pair<String, Boolean>> = mutableListOf()
  var favoriteFailure: ApiFailure? = null
  var favoriteGate: CompletableDeferred<Unit>? = null
  var favoriteAnswer: ((Boolean) -> Boolean)? = null

  var catalogsValue: List<CatalogDto> = emptyList()
  var librariesValue: List<LibraryDto> = emptyList()
  var librariesFailure: ApiFailure? = null
  var librariesCalls = 0
  var catalogPages: MutableMap<String, List<List<MetaDto>>> = mutableMapOf()
  var catalogRequests: MutableList<CatalogRequest> = mutableListOf()
  var failCatalogs = false
  var failCatalog = false
  var metaValues: MutableMap<String, MetaDto> = mutableMapOf()
  var metaRequests: MutableList<Triple<String, String, String?>> = mutableListOf()
  /** A gate keyed by `type:id` holds a `meta()` call until the test releases it. */
  var metaGates: MutableMap<String, CompletableDeferred<Unit>> = mutableMapOf()
  var streamsValues: MutableMap<String, List<StreamDto>> = mutableMapOf()
  /** Per-addon answers keyed by `type:id|addonKey`; takes precedence over [streamsValues]. */
  var addonStreams: MutableMap<String, List<StreamDto>> = mutableMapOf()
  var streamSourcesValues: MutableMap<String, List<StreamSourceDto>> = mutableMapOf()
  var streamSourcesRequests: MutableList<String> = mutableListOf()
  var streamsRequests: MutableList<String> = mutableListOf()
  /** Each `streams()` request that has finished answering, in completion order. */
  var streamsCompleted: MutableList<String> = mutableListOf()
  /** A gate keyed by `type:id` blocks a `streams()` call like a slow server would. Releasing it
   *  resumes the caller through the test clock, not a real thread. */
  var streamsGates: MutableMap<String, CompletableDeferred<Unit>> = mutableMapOf()
  var streamFailures: MutableMap<String, ApiFailure> = mutableMapOf()
  var streamSourcesFailures: MutableMap<String, ApiFailure> = mutableMapOf()
  var localStreamsResult: List<StreamDto> = emptyList()
  /** Per-request answers keyed by `type:id`; takes precedence over [localStreamsResult]. */
  var localStreamsValues: MutableMap<String, List<StreamDto>> = mutableMapOf()
  /** Held open until the test releases it, so a local answer can arrive after all addons did. */
  var localStreamsGate: CompletableDeferred<Unit>? = null
  var localStreamsError: ApiError? = null
  val localStreamsRequests: MutableList<String> = mutableListOf()
  var addonsValue: List<AddonDto> = emptyList()
  var addonsCalls = 0
  var settingsValue: SettingsResponse = SettingsResponse()
  var settingsCalls = 0
  /** Each `updateSettings()` call in order, so a test can assert one personal field per body. */
  var settingsPatches: MutableList<Pair<String, String>> = mutableListOf()
  /** When set, every `updateSettings()` throws it instead of answering. */
  var settingsFailure: ApiFailure? = null
  var languagesValue: List<LanguageDto> = listOf(
    LanguageDto("cs", "Čeština"),
    LanguageDto("en", "Angličtina"),
    LanguageDto("de", "Němčina"),
  )
  var serverVersionValue: String = "0.5.36"
  override var serverAddress: String = "http://server:8090"
  var progressEntries: List<ProgressEntryDto> = emptyList()
  var progressListCalls = 0
  var progressListGate: CompletableDeferred<Unit>? = null
  var watchlistValue: MutableList<WatchlistEntryDto> = mutableListOf()
  var watchlistCalls = 0
  var favoriteCalls: MutableList<Triple<String, String, Boolean>> = mutableListOf()
  var watchlistGate: CompletableDeferred<Unit>? = null
  var watchlistFailure: ApiFailure? = null
  var watchlistAnswer: ((Boolean) -> Boolean)? = null
  var downloads: MutableList<Pair<String?, MediaDto>> = mutableListOf()
  /** The source id each `download()` was called with, so a test can name the queued source. */
  var queuedSourceIds: MutableList<String> = mutableListOf()
  /** Every `download()` the screen asked for, counted as it arrives, in flight or not. */
  var downloadCalls = 0
  /** When set, `download()` waits for it before answering: a queue request that stays in flight. */
  var downloadGate: CompletableDeferred<Unit>? = null
  var downloadResult: DownloadResult = DownloadResult(status = "queued")
  var downloadFailure: ApiFailure? = null
  var downloadFailureMessage: String? = null
  var searchPages: MutableMap<String, SearchResultDto> = mutableMapOf()
  var searchRequests: MutableList<Pair<String, String?>> = mutableListOf()
  var failSearch = false

  var homeHandler: (List<String>) -> HomeResponseDto = { HomeResponseDto() }
  var homeRequests: MutableList<List<String>> = mutableListOf()
  var failHome = false
  var homeFailure: ApiFailure? = null
  var homeLayoutValue: HomeLayoutResponseDto = HomeLayoutResponseDto()
  var homeLayoutFailure: ApiFailure? = null
  var homeLayoutFailureMessage: String? = null
  var homeLayoutRequests = 0
  /** Each `updateHomeLayout()` call in order; `null` is the reset that clears the setting. */
  var homeLayoutPatches: MutableList<HomeLayoutDto?> = mutableListOf()
  /** When set, `updateHomeLayout()` holds the PATCH like a slow server would. */
  var homeLayoutPatchGate: CompletableDeferred<Unit>? = null
  var homeLayoutPatchFailure: ApiFailure? = null
  var homeLayoutPatchMessage: String? = null
  var downloadsValue: DownloadsResponseDto = DownloadsResponseDto()
  var downloadsRequests = 0

  var clientLogLines: MutableList<Triple<String, String, Map<String, String>?>> = mutableListOf()
  var bundles: MutableList<ClientLogBundleDto> = mutableListOf()
  var bundleResultId: String = "b1"
  var bundleFailure: ApiFailure? = null
  var bundleFailureMessage: String? = null

  override val http: OkHttpClient = OkHttpClient()

  override fun url(path: String): String = "http://server$path"

  override suspend fun browse(path: String?, limit: Int, skip: Int): BrowseResult {
    browseCalls += path to skip
    if (failBrowse) throw ApiError(ApiFailure.Generic)
    return pages[path] ?: BrowseResult(path.orEmpty(), emptyList(), 0, false)
  }

  override suspend fun favorites(limit: Int, skip: Int): BrowseResult {
    favoritesCalls += skip
    if (failFavorites) throw ApiError(ApiFailure.Generic)
    return favoritesValue
  }

  override suspend fun setFavorite(path: String, favorite: Boolean): FavoriteToggleDto {
    libraryFavoriteCalls += path to favorite
    favoriteGate?.await()
    favoriteFailure?.let { throw ApiError(it) }
    return FavoriteToggleDto(path, favoriteAnswer?.invoke(favorite) ?: favorite)
  }

  override suspend fun librarySource(path: String): SourceDto = SourceDto(sourceId = "src:$path")

  override suspend fun progress(key: String): ProgressDto? = progressValues[key]

  override suspend fun catalogs(): List<CatalogDto> {
    if (failCatalogs) throw ApiError(ApiFailure.Generic)
    return catalogsValue
  }

  override suspend fun libraries(): List<LibraryDto> {
    librariesCalls += 1
    librariesFailure?.let { throw ApiError(it) }
    return librariesValue
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

  override suspend fun meta(type: String, id: String, language: String?): MetaDto {
    metaRequests += Triple(type, id, language)
    metaGates["$type:$id"]?.await()
    return metaValues["$type:$id"] ?: throw ApiError(ApiFailure.NotFound)
  }

  override suspend fun streamSources(type: String, id: String): List<StreamSourceDto> {
    val key = "$type:$id"
    streamSourcesRequests += key
    streamSourcesFailures[key]?.let { throw ApiError(it) }
    return streamSourcesValues[key] ?: listOf(StreamSourceDto(key = "", name = ""))
  }

  override suspend fun streams(type: String, id: String, addon: String?): List<StreamDto> {
    val key = "$type:$id"
    val request = if (addon.isNullOrEmpty()) key else "$key|$addon"
    streamsRequests += request
    (streamsGates[request] ?: streamsGates[key])?.await()
    (streamFailures[request] ?: streamFailures[key])?.let { throw ApiError(it) }
    streamsCompleted += request
    return addonStreams[request] ?: streamsValues[key] ?: emptyList()
  }

  override suspend fun localStreams(type: String, id: String): List<StreamDto> {
    localStreamsRequests += "$type:$id"
    // A real request suspends cancellably; holding the gate on the current context keeps a
    // cancelled (stale) lookup from answering, which a plain `await` on UNDISPATCHED would not.
    localStreamsGate?.let { withContext(currentCoroutineContext()) { it.await() } }
    localStreamsError?.let { throw it }
    return localStreamsValues["$type:$id"] ?: localStreamsResult
  }

  override suspend fun addons(): List<AddonDto> {
    addonsCalls += 1
    return addonsValue
  }

  override suspend fun settings(): SettingsResponse {
    settingsCalls += 1
    return settingsValue
  }

  override suspend fun languages(): List<LanguageDto> = languagesValue

  override suspend fun serverVersion(): String = serverVersionValue

  override suspend fun updateSettings(field: String, value: String): SettingsResponse {
    settingsPatches += field to value
    settingsFailure?.let { throw ApiError(it) }
    settingsValue = when (field) {
      "uiLanguage" -> settingsValue.copy(uiLanguage = value)
      "audioLanguage" -> settingsValue.copy(audioLanguage = value)
      "subtitleLanguage" -> settingsValue.copy(subtitleLanguage = value)
      "startView" -> settingsValue.copy(startView = value)
      else -> settingsValue
    }
    return settingsValue
  }

  override suspend fun progressList(): List<ProgressEntryDto> {
    progressListCalls += 1
    progressListGate?.await()
    return progressEntries
  }

  override suspend fun watchlist(): List<WatchlistEntryDto> {
    watchlistCalls += 1
    return watchlistValue
  }

  override suspend fun setWatchlist(
    type: String,
    id: String,
    name: String,
    poster: String?,
    favorite: Boolean,
  ): WatchlistToggleDto {
    favoriteCalls += Triple(type, id, favorite)
    watchlistGate?.await()
    watchlistFailure?.let { throw ApiError(it) }
    return WatchlistToggleDto("$type:$id", watchlistAnswer?.invoke(favorite) ?: favorite)
  }

  override suspend fun download(title: String, sourceId: String, media: MediaDto, target: DownloadTargetDto?): DownloadResult {
    downloadCalls += 1
    downloadGate?.await()
    downloadFailure?.let { throw ApiError(it, serverMessage = downloadFailureMessage) }
    downloads += title to media
    queuedSourceIds += sourceId
    queuedTargets += target
    return downloadResult
  }

  val queuedTargets: MutableList<DownloadTargetDto?> = mutableListOf()

  override suspend fun home(rows: List<String>): HomeResponseDto {
    homeRequests += rows
    if (failHome) throw ApiError(ApiFailure.Generic)
    homeFailure?.let { throw ApiError(it) }
    return homeHandler(rows)
  }

  override suspend fun homeLayout(): HomeLayoutResponseDto {
    homeLayoutRequests += 1
    homeLayoutFailure?.let { throw ApiError(it, serverMessage = homeLayoutFailureMessage) }
    return homeLayoutValue
  }

  override suspend fun updateHomeLayout(layout: HomeLayoutDto?): SettingsResponse {
    homeLayoutPatches += layout
    homeLayoutPatchGate?.await()
    homeLayoutPatchFailure?.let { throw ApiError(it, serverMessage = homeLayoutPatchMessage) }
    return settingsValue
  }

  override suspend fun downloads(): DownloadsResponseDto {
    downloadsRequests += 1
    return downloadsValue
  }

  override suspend fun clientLog(level: String, message: String, context: Map<String, String>?) {
    clientLogLines += Triple(level, message, context)
  }

  override suspend fun sendClientLogBundle(bundle: ClientLogBundleDto): String {
    bundleFailure?.let { throw ApiError(it, serverMessage = bundleFailureMessage) }
    bundles += bundle
    return bundleResultId
  }

  override suspend fun startPlayback(
    sourceId: String,
    capabilities: ClientCapabilitiesDto,
    time: Double,
    subtitleIds: List<String>,
  ): PlaybackDescriptorDto {
    startedSources += sourceId
    startedTimes += time
    startedCapabilities += capabilities
    startedSubtitleIds += subtitleIds
    return startAnswer
  }

  var startAnswer: PlaybackDescriptorDto = PlaybackDescriptorDto(id = "p1", url = "stream.mp4")
  val startedSubtitleIds: MutableList<List<String>> = mutableListOf()
  /** Every start, in order: which source, at what time and with what the client claimed. */
  val startedSources: MutableList<String> = mutableListOf()
  val startedTimes: MutableList<Double> = mutableListOf()
  val startedCapabilities: MutableList<ClientCapabilitiesDto> = mutableListOf()
  val deletedIds: MutableList<String> = mutableListOf()

  override suspend fun trackPlayback(id: String, change: TrackChange): PlaybackDescriptorDto {
    trackChanges += change
    return trackAnswer ?: PlaybackDescriptorDto(id = id, url = "stream.mp4")
  }

  var trackAnswer: PlaybackDescriptorDto? = null
  val trackChanges: MutableList<TrackChange> = mutableListOf()

  override suspend fun subtitles(type: String, id: String): List<AddonSubtitleDto> {
    subtitlesRequests += type to id
    return subtitlesValue
  }

  var subtitlesValue: List<AddonSubtitleDto> = emptyList()
  val subtitlesRequests: MutableList<Pair<String, String>> = mutableListOf()

  override suspend fun subtitleText(id: String, offset: Double, delay: Double): String? {
    subtitleTextRequests += Triple(id, offset, delay)
    return subtitleTextValue
  }

  var subtitleTextValue: String? = null
  val subtitleTextRequests: MutableList<Triple<String, Double, Double>> = mutableListOf()

  override suspend fun libraryNext(sourceId: String): NextFileDto? {
    libraryNextRequests += sourceId
    return libraryNextValue
  }

  var libraryNextValue: NextFileDto? = null
  val libraryNextRequests: MutableList<String> = mutableListOf()

  override suspend fun sidecar(url: String, position: Double, delay: Double): SidecarFetch? {
    sidecarRequests += Triple(url, position, delay)
    return sidecarValue
  }

  var sidecarValue: SidecarFetch? = null
  val sidecarRequests: MutableList<Triple<String, Double, Double>> = mutableListOf()

  override suspend fun seekPlayback(id: String, time: Double): PlaybackDescriptorDto =
    PlaybackDescriptorDto(id = id, url = "stream.m3u8", playlist = true, offset = time)

  val escalatedTimes: MutableList<Double> = mutableListOf()

  /** A forced conversion, as the server answers it: no copy left in the session. */
  override suspend fun escalatePlayback(id: String, time: Double): PlaybackDescriptorDto {
    escalatedTimes += time
    return PlaybackDescriptorDto(
      id = id,
      mode = "transcode",
      url = "escalated.m3u8",
      playlist = true,
      offset = time,
      copy = CopyDto(video = false, audio = false),
    )
  }

  override suspend fun pingPlayback(id: String) {}

  override suspend fun deletePlayback(id: String) {
    deletedIds += id
  }

  override suspend fun saveProgress(
    key: String,
    position: Double,
    duration: Double,
    title: String,
    path: String?,
    poster: String?,
    addonKey: String?,
  ) {}
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
