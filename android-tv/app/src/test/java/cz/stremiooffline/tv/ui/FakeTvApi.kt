package cz.stremiooffline.tv.ui

import cz.stremiooffline.tv.data.AddonDto
import cz.stremiooffline.tv.data.AddonSubtitleDto
import cz.stremiooffline.tv.data.BulkDownloadRequest
import cz.stremiooffline.tv.data.BulkDownloadResult
import cz.stremiooffline.tv.data.BulkEpisodeDto
import cz.stremiooffline.tv.data.BulkMediaDto
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.BrowseResult
import cz.stremiooffline.tv.data.CatalogDto
import cz.stremiooffline.tv.data.CatalogSearchPollDto
import cz.stremiooffline.tv.data.CatalogSearchSnapshotDto
import cz.stremiooffline.tv.data.CatalogSearchStartDto
import cz.stremiooffline.tv.data.CatalogSearchStartResultDto
import cz.stremiooffline.tv.data.ClientLogBundleDto
import cz.stremiooffline.tv.data.ClientCapabilitiesDto
import cz.stremiooffline.tv.data.CopyDto
import cz.stremiooffline.tv.data.DownloadResult
import cz.stremiooffline.tv.data.DownloadSelectionDto
import cz.stremiooffline.tv.data.DownloadTargetDto
import cz.stremiooffline.tv.data.DownloadsResponseDto
import cz.stremiooffline.tv.data.FavoriteFilter
import cz.stremiooffline.tv.data.FavoriteToggleDto
import cz.stremiooffline.tv.data.FavoritesPage
import cz.stremiooffline.tv.data.HomeResponseDto
import cz.stremiooffline.tv.data.HomeLayoutDto
import cz.stremiooffline.tv.data.HomeLayoutResponseDto
import cz.stremiooffline.tv.data.GlobalSearchMemberPageDto
import cz.stremiooffline.tv.data.GlobalSearchPollDto
import cz.stremiooffline.tv.data.GlobalSearchSnapshotDto
import cz.stremiooffline.tv.data.GlobalSearchStartDto
import cz.stremiooffline.tv.data.GlobalSearchStartResultDto
import cz.stremiooffline.tv.data.LanguageDto
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.LibraryTitleDto
import cz.stremiooffline.tv.data.MediaDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.NextFileDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.ProgressEntryDto
import cz.stremiooffline.tv.data.ResumeFilter
import cz.stremiooffline.tv.data.ResumePage
import cz.stremiooffline.tv.data.RecentSearchDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteItemDetailDto
import cz.stremiooffline.tv.data.RemoteItemStateDto
import cz.stremiooffline.tv.data.RemoteItemStatePatch
import cz.stremiooffline.tv.data.RemoteItemsPageDto
import cz.stremiooffline.tv.data.RemoteLibraryDto
import cz.stremiooffline.tv.data.RemotePlaybackReport
import cz.stremiooffline.tv.data.RemotePreviewDto
import cz.stremiooffline.tv.data.SearchStateDto
import cz.stremiooffline.tv.data.SearchResultDto
import cz.stremiooffline.tv.data.SearchScope
import cz.stremiooffline.tv.data.SearchableCatalogDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.SidecarFetch
import cz.stremiooffline.tv.data.SourceDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.StreamSourceDto
import cz.stremiooffline.tv.data.TrackChange
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.data.bulkDownloadBody
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
  /** Every browse call with the whole query it carried, so a test can name what was asked. */
  val browseRequests: MutableList<BrowseRequest> = mutableListOf()
  /** Answers for a narrowed level, keyed by `path|query`; a query with no answer is empty. */
  var browseQueries: MutableMap<String, BrowseResult> = mutableMapOf()
  var failBrowse = false
  var favoritesValue: FavoritesPage = FavoritesPage(emptyList(), 0, false)
  var favoritesRequests: MutableList<FavoriteFilter> = mutableListOf()
  var failFavorites = false
  var resumeValue: ResumePage = ResumePage(emptyList(), 0, false)
  /** Per-skip answers; a skip not listed falls back to [resumeValue], so a test can page. */
  var resumePages: MutableMap<Int, ResumePage> = mutableMapOf()
  var resumeRequests: MutableList<ResumeFilter> = mutableListOf()
  var resumeSkips: MutableList<Int> = mutableListOf()
  var failResume = false
  /** Every `forgetProgress()` call in order, so a test can name the keys it carried. */
  var forgetCalls: MutableList<List<String>> = mutableListOf()
  var forgetFailure: ApiFailure? = null
  var libraryFavoriteCalls: MutableList<Pair<String, Boolean>> = mutableListOf()
  var favoriteFailure: ApiFailure? = null
  var favoriteGate: CompletableDeferred<Unit>? = null
  var favoriteAnswer: ((Boolean) -> Boolean)? = null

  var catalogsValue: List<CatalogDto> = emptyList()
  var librariesValue: List<LibraryDto> = emptyList()
  var librariesFailure: ApiFailure? = null
  /** Held open until the test releases it, so a destination read can land after a move. */
  var librariesGate: CompletableDeferred<Unit>? = null
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
  /** How many `streams()` calls are out right now, and the most that ever were: a test watches the
   *  cap on how many addons one panel asks at a time. */
  var streamsInFlight = 0
  var streamsPeakInFlight = 0
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
  /** When set, the next `addons()` calls refuse until it is cleared, as a server would. */
  var addonsFailure: ApiFailure? = null
  var settingsValue: SettingsResponse = SettingsResponse()
  var settingsCalls = 0
  /** The account's own settings read (`GET /api/settings`); a patch failure is its own field. */
  var settingsReadFailure: ApiFailure? = null
  /** Held open until the test releases it, so a settings answer can land late. */
  var settingsReadGate: CompletableDeferred<Unit>? = null
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
  /** The addon each `setWatchlist` call named, in order. */
  var favoriteAddonKeys: MutableList<String?> = mutableListOf()
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
  var searchRequests: MutableList<SearchRequest> = mutableListOf()
  var failSearch = false
  var catalogStartHandler: suspend (CatalogSearchStartDto) -> CatalogSearchStartResultDto = { request ->
    CatalogSearchStartResultDto(
      id = "cs_${request.generation}",
      snapshot = CatalogSearchSnapshotDto(revision = 1, state = "complete"),
    )
  }
  var catalogPollHandler: suspend (String, Int) -> CatalogSearchPollDto = { _, revision ->
    CatalogSearchPollDto(changed = false, revision = revision)
  }
  var catalogPageHandler: suspend (String) -> Int = { 2 }
  var catalogDeleteHandler: suspend (String) -> Unit = {}
  val catalogStartCalls: MutableList<CatalogSearchStartDto> = mutableListOf()
  val catalogPollCalls: MutableList<Pair<String, Int>> = mutableListOf()
  val catalogPageCalls: MutableList<String> = mutableListOf()
  val catalogDeletedIds: MutableList<String> = mutableListOf()
  var searchableValue: List<SearchableCatalogDto> = emptyList()
  var searchableCalls = 0
  var searchStateValue: SearchStateDto = SearchStateDto()
  var searchStateCalls = 0
  var searchStateFailure: ApiFailure? = null
  /** Every `recordSearch()` the code called, in order, whether or not saving was on. */
  val recordedSearches: MutableList<String> = mutableListOf()
  val forgottenSearches: MutableList<String> = mutableListOf()
  var clearHistoryCalls = 0

  var globalSearchEnabled = false
  var globalSearchEnabledCalls = 0
  var globalStartHandler: suspend (GlobalSearchStartDto) -> GlobalSearchStartResultDto = { request ->
    GlobalSearchStartResultDto(
      id = "gs_${request.generation}",
      snapshot = GlobalSearchSnapshotDto(revision = 1, state = "complete"),
    )
  }
  var globalPollHandler: suspend (String, Int) -> GlobalSearchPollDto = { _, revision ->
    GlobalSearchPollDto(changed = false, revision = revision)
  }
  var globalPageHandler: suspend (String) -> Unit = {}
  var globalRetryHandler: suspend (String, String) -> Unit = { _, _ -> }
  var globalMembersHandler: suspend (String, String, Int) -> GlobalSearchMemberPageDto = { _, _, _ ->
    GlobalSearchMemberPageDto()
  }
  var globalDeleteHandler: suspend (String) -> Unit = {}
  val globalStartCalls: MutableList<GlobalSearchStartDto> = mutableListOf()
  val globalPollCalls: MutableList<Pair<String, Int>> = mutableListOf()
  val globalPageCalls: MutableList<String> = mutableListOf()
  val globalRetryCalls: MutableList<Pair<String, String>> = mutableListOf()
  val globalMembersCalls: MutableList<Triple<String, String, Int>> = mutableListOf()
  val globalDeletedIds: MutableList<String> = mutableListOf()

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

  var remoteLibrariesValue: List<RemoteLibraryDto>? = emptyList()
  var remoteLibrariesFailure: ApiFailure? = null
  var remoteLibrariesCalls = 0
  /** Held open until the test releases it, so the discovery deadline can be watched. */
  var remoteLibrariesGate: CompletableDeferred<Unit>? = null
  /** One page per `libraryId|cursor` (`libraryId|` is the first, uncursored page). */
  var remoteItemsPages: MutableMap<String, RemoteItemsPageDto> = mutableMapOf()
  val remoteItemsRequests: MutableList<Pair<String, String?>> = mutableListOf()
  var remoteItemsFailure: ApiError? = null
  /** One page per `itemId|cursor`. */
  var remoteEpisodesPages: MutableMap<String, RemoteItemsPageDto> = mutableMapOf()
  val remoteEpisodesRequests: MutableList<Triple<String, String, String?>> = mutableListOf()
  /** Dedicated browse answers keyed by `libraryId|parentId|cursor`; a miss falls back below. */
  var remoteBrowsePages: MutableMap<String, RemoteItemsPageDto> = mutableMapOf()
  /** Every browse call, with the full query it carried, so a test can name the request. */
  val remoteBrowseRequests: MutableList<RemoteBrowseRequest> = mutableListOf()
  var remoteBrowseFailure: ApiError? = null
  val remoteBrowseGates: MutableMap<String, CompletableDeferred<Unit>> = mutableMapOf()
  /** The posters every preview answers with; a test may gate or fail the call. */
  var remotePreviewValue: List<String> = emptyList()
  val remotePreviewRequests: MutableList<Pair<String, String?>> = mutableListOf()
  var remotePreviewFailure: ApiError? = null
  /** Held open until the test releases it, so preview concurrency can be watched. */
  var remotePreviewGate: CompletableDeferred<Unit>? = null
  var remoteSourcesValue: List<StreamDto> = emptyList()
  var remoteSourcesFailure: ApiError? = null
  val remoteSourcesRequests: MutableList<Pair<String, String>> = mutableListOf()
  var remoteStateValue: RemoteItemStateDto = RemoteItemStateDto()
  var remoteStateFailure: ApiError? = null
  var remoteItemValues: MutableMap<String, RemoteItemDetailDto> = mutableMapOf()
  var remoteItemFailure: ApiError? = null
  val remoteItemRequests: MutableList<Pair<String, String>> = mutableListOf()
  /** One answer per `libraryId|type|id`; a key in [remoteMatchFailures] refuses instead. */
  val remoteMatchValues: MutableMap<String, List<StreamDto>> = mutableMapOf()
  val remoteMatchFailures: MutableSet<String> = mutableSetOf()
  val remoteMatchRequests: MutableList<String> = mutableListOf()
  /** The name hint each request carried, in the same order as [remoteMatchRequests]. */
  val remoteMatchHints: MutableList<String?> = mutableListOf()
  /** A gate keyed by `libraryId|type|catalogId` holds one match like a slow provider would. */
  var remoteMatchGates: MutableMap<String, CompletableDeferred<Unit>> = mutableMapOf()
  /** How many matches are out right now, and the most that ever were. */
  var remoteMatchesInFlight = 0
  var remoteMatchesPeakInFlight = 0

  var clientLogLines: MutableList<Triple<String, String, Map<String, String>?>> = mutableListOf()
  var bundles: MutableList<ClientLogBundleDto> = mutableListOf()
  var bundleResultId: String = "b1"
  var bundleFailure: ApiFailure? = null
  var bundleFailureMessage: String? = null

  override val http: OkHttpClient = OkHttpClient()

  override fun url(path: String): String = "http://server$path"

  override suspend fun browse(path: String?, limit: Int, skip: Int, query: String): BrowseResult {
    browseCalls += path to skip
    browseRequests += BrowseRequest(path, limit, skip, query)
    if (failBrowse) throw ApiError(ApiFailure.Generic)
    if (query.isNotEmpty()) {
      return browseQueries["${path.orEmpty()}|$query"] ?: BrowseResult(path.orEmpty(), emptyList(), 0, false)
    }
    return pages[path] ?: BrowseResult(path.orEmpty(), emptyList(), 0, false)
  }

  override suspend fun favorites(filter: FavoriteFilter, limit: Int, skip: Int): FavoritesPage {
    favoritesRequests += filter
    if (failFavorites) throw ApiError(ApiFailure.Generic)
    return favoritesValue
  }

  override suspend fun resume(filter: ResumeFilter, limit: Int, skip: Int): ResumePage {
    resumeRequests += filter
    resumeSkips += skip
    if (failResume) throw ApiError(ApiFailure.Generic)
    return resumePages[skip] ?: resumeValue
  }

  override suspend fun forgetProgress(keys: List<String>) {
    forgetCalls += keys
    forgetFailure?.let { throw ApiError(it) }
    keys.forEach { progressValues.remove(it) }
    progressEntries = progressEntries.filterNot { it.key in keys }
  }

  override suspend fun setFavorite(path: String, favorite: Boolean): FavoriteToggleDto {
    libraryFavoriteCalls += path to favorite
    favoriteGate?.await()
    favoriteFailure?.let { throw ApiError(it) }
    return FavoriteToggleDto(path, favoriteAnswer?.invoke(favorite) ?: favorite)
  }

  override suspend fun librarySource(path: String): SourceDto = SourceDto(sourceId = "src:$path")

  /** The title each library path is bound to; a path not listed here is unbound. */
  var libraryTitleValues: MutableMap<String, LibraryTitleDto> = mutableMapOf()
  val libraryTitleRequests: MutableList<String> = mutableListOf()
  var libraryTitleFailure: ApiError? = null
  /** Held open until the test releases it, so a play can be watched while the lookup is out. */
  var libraryTitleGate: CompletableDeferred<Unit>? = null

  override suspend fun libraryTitle(path: String): LibraryTitleDto? {
    libraryTitleRequests += path
    libraryTitleGate?.let { withContext(currentCoroutineContext()) { it.await() } }
    libraryTitleFailure?.let { throw it }
    return libraryTitleValues[path]
  }

  override suspend fun progress(key: String): ProgressDto? = progressValues[key]

  override suspend fun catalogs(): List<CatalogDto> {
    if (failCatalogs) throw ApiError(ApiFailure.Generic)
    return catalogsValue
  }

  override suspend fun libraries(): List<LibraryDto> {
    librariesCalls += 1
    librariesGate?.await()
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

  override suspend fun searchable(): List<SearchableCatalogDto> {
    searchableCalls += 1
    return searchableValue
  }

  override suspend fun searchEverywhereEnabled(): Boolean {
    globalSearchEnabledCalls += 1
    return globalSearchEnabled
  }

  override suspend fun startGlobalSearch(body: GlobalSearchStartDto): GlobalSearchStartResultDto {
    globalStartCalls += body
    return globalStartHandler(body)
  }

  override suspend fun pollGlobalSearch(id: String, revision: Int): GlobalSearchPollDto {
    globalPollCalls += id to revision
    return globalPollHandler(id, revision)
  }

  override suspend fun pageGlobalSearch(id: String) {
    globalPageCalls += id
    globalPageHandler(id)
  }

  override suspend fun retryGlobalSearchSource(id: String, sourceId: String) {
    globalRetryCalls += id to sourceId
    globalRetryHandler(id, sourceId)
  }

  override suspend fun globalSearchMembers(id: String, memberKey: String, from: Int): GlobalSearchMemberPageDto {
    globalMembersCalls += Triple(id, memberKey, from)
    return globalMembersHandler(id, memberKey, from)
  }

  override suspend fun deleteGlobalSearch(id: String) {
    globalDeletedIds += id
    globalDeleteHandler(id)
  }

  override suspend fun search(query: String, cursor: String?, scope: SearchScope): SearchResultDto {
    searchRequests += SearchRequest(query, cursor, scope)
    if (failSearch) throw ApiError(ApiFailure.Generic)
    return searchPages[cursor ?: ""] ?: SearchResultDto()
  }

  override suspend fun startCatalogSearch(body: CatalogSearchStartDto): CatalogSearchStartResultDto {
    catalogStartCalls += body
    return catalogStartHandler(body)
  }

  override suspend fun pollCatalogSearch(id: String, revision: Int): CatalogSearchPollDto {
    catalogPollCalls += id to revision
    return catalogPollHandler(id, revision)
  }

  override suspend fun pageCatalogSearch(id: String): Int {
    catalogPageCalls += id
    return catalogPageHandler(id)
  }

  override suspend fun deleteCatalogSearch(id: String) {
    catalogDeletedIds += id
    catalogDeleteHandler(id)
  }

  override suspend fun searchState(): SearchStateDto {
    searchStateCalls += 1
    searchStateFailure?.let { throw ApiError(it) }
    return searchStateValue
  }

  /** Mirrors the server: trims, dedupes, caps at twenty and ignores a query while saving is off. */
  override suspend fun recordSearch(query: String) {
    recordedSearches += query
    val trimmed = query.trim()
    if (!searchStateValue.saveHistory || trimmed.isEmpty()) return
    val recent = searchStateValue.recent.filterNot { it.query == trimmed }
    searchStateValue = searchStateValue.copy(recent = (listOf(RecentSearchDto(trimmed, usedAt = "now")) + recent).take(20))
  }

  override suspend fun forgetSearch(query: String): SearchStateDto {
    forgottenSearches += query
    searchStateValue = searchStateValue.copy(recent = searchStateValue.recent.filterNot { it.query == query })
    return searchStateValue
  }

  override suspend fun clearSearchHistory(): SearchStateDto {
    clearHistoryCalls += 1
    searchStateValue = searchStateValue.copy(recent = emptyList())
    return searchStateValue
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
    streamsInFlight += 1
    streamsPeakInFlight = maxOf(streamsPeakInFlight, streamsInFlight)
    try {
      (streamsGates[request] ?: streamsGates[key])?.await()
      (streamFailures[request] ?: streamFailures[key])?.let { throw ApiError(it) }
      streamsCompleted += request
      return addonStreams[request] ?: streamsValues[key] ?: emptyList()
    } finally {
      streamsInFlight -= 1
    }
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
    addonsFailure?.let { throw ApiError(it) }
    return addonsValue
  }

  override suspend fun settings(): SettingsResponse {
    settingsCalls += 1
    settingsReadGate?.let { withContext(currentCoroutineContext()) { it.await() } }
    settingsReadFailure?.let { throw ApiError(it) }
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
    addonKey: String?,
  ): WatchlistToggleDto {
    favoriteCalls += Triple(type, id, favorite)
    favoriteAddonKeys += addonKey
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

  /** Every bulk body the panel posted, in order. */
  val bulkDownloads: MutableList<BulkDownloadRequest> = mutableListOf()
  /** Counted as it arrives, in flight or not, so a double press is visible to a test. */
  var bulkDownloadCalls = 0
  var bulkDownloadResult: BulkDownloadResult = BulkDownloadResult(added = 1)
  /** When set, `downloadBulk()` waits for it before answering. */
  var bulkDownloadGate: CompletableDeferred<Unit>? = null
  var bulkDownloadFailure: ApiFailure? = null
  var bulkDownloadFailureMessage: String? = null

  override suspend fun downloadBulk(
    title: String,
    type: String,
    episodes: List<BulkEpisodeDto>,
    selection: DownloadSelectionDto,
    media: BulkMediaDto,
    target: DownloadTargetDto?,
  ): BulkDownloadResult {
    bulkDownloadCalls += 1
    bulkDownloadGate?.await()
    bulkDownloadFailure?.let { throw ApiError(it, serverMessage = bulkDownloadFailureMessage) }
    bulkDownloads += bulkDownloadBody(title, type, episodes, selection, media, target)
    return bulkDownloadResult
  }

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

  override suspend fun remoteLibraries(): List<RemoteLibraryDto> {
    remoteLibrariesCalls += 1
    remoteLibrariesGate?.let { withContext(currentCoroutineContext()) { it.await() } }
    remoteLibrariesFailure?.let { throw ApiError(it) }
    return remoteLibrariesValue ?: throw ApiError(ApiFailure.Generic)
  }

  override suspend fun remoteItems(
    libraryId: String,
    limit: Int,
    cursor: String?,
    search: String?,
    type: String?,
  ): RemoteItemsPageDto {
    remoteItemsRequests += libraryId to cursor
    remoteItemsFailure?.let { throw it }
    return remoteItemsPages["$libraryId|${cursor ?: ""}"] ?: RemoteItemsPageDto()
  }

  override suspend fun remoteItem(libraryId: String, itemId: String): RemoteItemDetailDto {
    remoteItemRequests += libraryId to itemId
    remoteItemFailure?.let { throw it }
    return remoteItemValues["$libraryId:$itemId"] ?: throw ApiError(ApiFailure.NotFound)
  }

  override suspend fun remoteBrowse(
    libraryId: String,
    limit: Int,
    cursor: String?,
    search: String?,
    type: String?,
    parentId: String?,
    mode: String?,
    sort: String?,
    order: String?,
  ): RemoteItemsPageDto {
    remoteBrowseRequests += RemoteBrowseRequest(libraryId, limit, cursor, search, type, parentId, mode, sort, order)
    remoteBrowseGates[parentId ?: ""]?.await()
    remoteBrowseFailure?.let { throw it }
    remoteBrowsePages["$libraryId|${parentId ?: ""}|${cursor ?: ""}"]?.let { return it }
    // The older suites only seeded the snapshot maps; answer from those and keep their counters
    // alive, so a pre-browse test still drives the same listing through the new route.
    return when {
      parentId != null && (type == "episode" || mode == "titles") -> {
        remoteEpisodesRequests += Triple(libraryId, parentId, cursor)
        remoteEpisodesPages["$parentId|${cursor ?: ""}"] ?: RemoteItemsPageDto()
      }
      else -> {
        remoteItemsRequests += libraryId to cursor
        remoteItemsPages["$libraryId|${cursor ?: ""}"] ?: RemoteItemsPageDto()
      }
    }
  }

  override suspend fun remotePreview(libraryId: String, parentId: String?): RemotePreviewDto {
    remotePreviewRequests += libraryId to parentId
    remotePreviewGate?.await()
    remotePreviewFailure?.let { throw it }
    return RemotePreviewDto(remotePreviewValue)
  }

  override suspend fun remoteEpisodes(
    libraryId: String,
    itemId: String,
    limit: Int,
    cursor: String?,
  ): RemoteItemsPageDto {
    remoteEpisodesRequests += Triple(libraryId, itemId, cursor)
    remoteItemsFailure?.let { throw it }
    return remoteEpisodesPages["$itemId|${cursor ?: ""}"] ?: RemoteItemsPageDto()
  }

  override suspend fun remoteSources(libraryId: String, itemId: String): List<StreamDto> {
    remoteSourcesRequests += libraryId to itemId
    remoteSourcesFailure?.let { throw it }
    return remoteSourcesValue
  }

  var remoteStateReadGate: CompletableDeferred<Unit>? = null

  override suspend fun remoteItemState(libraryId: String, itemId: String): RemoteItemStateDto {
    remoteStateReadGate?.await()
    remoteStateFailure?.let { throw it }
    return remoteStateValue
  }

  /** Every state PATCH in order, so a test can name the fields the screen wrote. */
  var remoteStatePatches: MutableList<RemoteItemStatePatch> = mutableListOf()
  var remoteStatePatchFailure: ApiError? = null

  val remotePlaybackReports: MutableList<Triple<String, String, RemotePlaybackReport>> = mutableListOf()

  override suspend fun reportRemotePlayback(libraryId: String, itemId: String, report: RemotePlaybackReport) {
    remotePlaybackReports += Triple(libraryId, itemId, report)
  }

  override suspend fun patchRemoteItemState(
    libraryId: String,
    itemId: String,
    patch: RemoteItemStatePatch,
  ): RemoteItemStateDto {
    remoteStatePatches += patch
    remoteStatePatchFailure?.let { throw it }
    // Mirrors the server: only the fields the patch set travel and the rest stay as they were.
    remoteStateValue = remoteStateValue.copy(
      position = patch.position ?: remoteStateValue.position,
      duration = patch.duration ?: remoteStateValue.duration,
      favorite = patch.favorite ?: remoteStateValue.favorite,
      watched = patch.watched ?: remoteStateValue.watched,
      mediaSourceId = patch.mediaSourceId ?: remoteStateValue.mediaSourceId,
    )
    return remoteStateValue
  }

  override suspend fun remoteMatchedStreams(libraryId: String, type: String, catalogId: String, nameHint: String?): List<StreamDto> {
    val key = "$libraryId|$type|$catalogId"
    remoteMatchRequests += key
    remoteMatchHints += nameHint
    remoteMatchesInFlight += 1
    remoteMatchesPeakInFlight = maxOf(remoteMatchesPeakInFlight, remoteMatchesInFlight)
    try {
      remoteMatchGates[key]?.let { withContext(currentCoroutineContext()) { it.await() } }
      if (key in remoteMatchFailures) throw ApiError(ApiFailure.Generic)
      return remoteMatchValues[key] ?: emptyList()
    } finally {
      remoteMatchesInFlight -= 1
    }
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
    audioLanguage: String?,
    subtitleLanguage: String?,
    subtitleOff: Boolean,
  ): PlaybackDescriptorDto {
    startedSources += sourceId
    startedTimes += time
    startedCapabilities += capabilities
    startedSubtitleIds += subtitleIds
    startedLanguages += StartLanguages(audioLanguage, subtitleLanguage, subtitleOff)
    return startAnswer
  }

  var startAnswer: PlaybackDescriptorDto = PlaybackDescriptorDto(id = "p1", url = "stream.mp4")
  val startedSubtitleIds: MutableList<List<String>> = mutableListOf()
  /** The track choices each start named on the wire, in order. */
  val startedLanguages: MutableList<StartLanguages> = mutableListOf()
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
    remote: RemoteItemContext?,
    stableKey: String?,
  ) {
    progressSaves += ProgressSave(key, position, duration, title, path, poster, addonKey, remote, stableKey)
  }

  /** Every `saveProgress()` call in order, so a test can name the key and the numbers behind it. */
  val progressSaves: MutableList<ProgressSave> = mutableListOf()
}

data class ProgressSave(
  val key: String,
  val position: Double,
  val duration: Double,
  val title: String,
  val path: String?,
  val poster: String?,
  val addonKey: String?,
  val remote: RemoteItemContext?,
  val stableKey: String?,
)

data class CatalogRequest(val addonKey: String, val type: String, val id: String, val skip: Int, val genre: String?)

/** What one start asked the server for: a null language is one the account's settings decide. */
data class StartLanguages(val audio: String?, val subtitle: String?, val subtitleOff: Boolean)

data class BrowseRequest(val path: String?, val limit: Int, val skip: Int, val query: String)

data class SearchRequest(val query: String, val cursor: String?, val scope: SearchScope)

data class RemoteBrowseRequest(
  val libraryId: String,
  val limit: Int,
  val cursor: String?,
  val search: String?,
  val type: String?,
  val parentId: String?,
  val mode: String?,
  val sort: String?,
  val order: String?,
)

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
