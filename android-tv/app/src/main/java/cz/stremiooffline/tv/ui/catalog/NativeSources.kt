package cz.stremiooffline.tv.ui.catalog

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.res.stringResource
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.catalog.ProgressKey
import cz.stremiooffline.tv.catalog.Streams
import cz.stremiooffline.tv.data.AddonDto
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.CatalogApi
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.RemoteLibraryApi
import cz.stremiooffline.tv.data.RemoteLibraryDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.StreamSourceDto
import cz.stremiooffline.tv.playback.Progress
import cz.stremiooffline.tv.ui.detail.PlayTarget
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withTimeoutOrNull

/** The test tag of the panel's own Retry, so the note and the failure block name it apart from the
 *  detail's own versions retry. */
const val TagRemoteSourcesPanelRetry = "remote_sources_panel_retry"

/** A group deadline must end every addon wait, or the panel would spin on a silent addon forever. */
private const val ADDON_GROUP_TIMEOUT_MS = 8_000L

/** Two requests of one category at a time: enough to overlap the slow ones on a TV, few enough
 *  that a panel opening does not flood the server. */
private const val MAX_GROUP_REQUESTS = 2

/** Where one supplementary group of a native item's panel stands. */
enum class SourceGroupLoad { Idle, Loading, Failed, Empty, Loaded }

/** The sources one native item offers besides its own versions, as the groups report them: the
 *  viewer's own copies, the versions the other media servers matched, the addon rows, and what is
 *  still owed. The item's own versions stay in the caller's hand and are never asked about here. */
data class NativeSourceState(
  val settings: SettingsResponse = SettingsResponse(),
  val addons: List<AddonDto> = emptyList(),
  val realDebridConfigured: Boolean = false,
  /** The viewer's own library copies of this title or episode. */
  val local: List<StreamDto> = emptyList(),
  /** Every addon row loaded for this item, deduped by a nonblank source id. */
  val addonRows: List<StreamDto> = emptyList(),
  /** The addons' own messages: an addon that cannot be played through the server says so here at
   *  most once, attributed to the provider that wrote it. A notice is never a row: it is not
   *  selectable and never the default. */
  val notices: List<StreamDto> = emptyList(),
  /** The versions the other media servers matched, in the configured library order. */
  val remoteGroups: List<Streams.RemoteGroup> = emptyList(),
  /** True while any group still owes an answer. */
  val asking: Boolean = false,
  /** The libraries and providers that refused, named for the panel's own note. */
  val failedLabels: List<String> = emptyList(),
  /** A group that failed without a name of its own: the viewer's own copies, the account's
   *  settings, the addon list or the library list. */
  val unnamedFailure: Boolean = false,
)

/**
 * The unified scoped loading coordinator behind a native item's Sources panel. Opening the panel
 * is the intent that starts it: the viewer's own copies, every configured addon provider and every
 * other media library are asked at once, and each group publishes the moment it answers so the
 * item's own versions stay usable while the rest are still out. Nothing is asked before the panel
 * is opened, nothing is asked of the library the item was opened from -- its versions are already
 * in hand -- and the panel's own Retry asks only the groups that failed: a group that answered, even
 * with nothing, keeps what it said.
 *
 * The state lives with the item, so closing and reopening the panel reuses what answered; a new
 * item gets a new coordinator and the caller cancels this one's scope with it. Every request is
 * derived from the item's exact catalogue identity: no title, filename or opaque native id is ever
 * guessed into one.
 */
class NativeSources(
  private val catalogApi: CatalogApi,
  private val remoteApi: RemoteLibraryApi,
  /** The library the item was opened from: its own versions are in hand and never matched again. */
  private val originLibraryId: String,
  /** The exact catalogue identity (`type` to `id`) the supplementary groups are asked about. */
  private val identity: Pair<String, String>,
  /** The resolved catalogue title the provider's own name filter takes: a series name for an
   *  episode, never the episode's own. */
  private val nameHint: String?,
) {
  private val type = identity.first
  private val id = identity.second

  var state by mutableStateOf(NativeSourceState())
    private set

  private var started = false
  private var settingsValue = SettingsResponse()
  private var addonList: List<AddonDto> = emptyList()
  private var providerList: List<StreamSourceDto> = emptyList()
  private var libraryList: List<RemoteLibraryDto> = emptyList()
  private var localRows: List<StreamDto> = emptyList()
  private var addonDiscovery = SourceGroupLoad.Idle
  /** The account's settings and the addon list are groups of their own: each is retried alone. */
  private var settingsLoad = SourceGroupLoad.Idle
  private var addonsLoad = SourceGroupLoad.Idle
  private var localLoad = SourceGroupLoad.Idle
  private var remoteDiscovery = SourceGroupLoad.Idle
  private val providerLoads = LinkedHashMap<String, SourceGroupLoad>()
  private val providerRows = LinkedHashMap<String, List<StreamDto>>()
  private val providerNotices = LinkedHashMap<String, List<StreamDto>>()
  private val remoteLoads = LinkedHashMap<String, SourceGroupLoad>()
  private val remoteRows = LinkedHashMap<String, List<StreamDto>>()
  private val addonPermits = Semaphore(MAX_GROUP_REQUESTS)
  private val remotePermits = Semaphore(MAX_GROUP_REQUESTS)

  /** The panel was opened. The first open starts every group; a later open of the same item asks
   *  nothing, because the answers that landed are still here. */
  fun open(scope: CoroutineScope) {
    if (started) return
    started = true
    load(scope)
  }

  /** The panel's own Retry: every group that failed is asked again, and the groups that already
   *  answered keep their rows. An empty answer is an answer -- a provider or a library that
   *  matched nothing is not asked a second time for nothing. */
  fun retry(scope: CoroutineScope) {
    if (!started) {
      open(scope)
      return
    }
    load(scope)
  }

  private fun load(scope: CoroutineScope) {
    if (!settled(localLoad)) loadLocal(scope)
    loadMetadata(scope)
    loadAddons(scope)
    loadRemotes(scope)
  }

  /**
   * The account's settings (the panel's language, its torrent rule) and the addon list (the order
   * the addons are ranked in) are read beside the providers, so a slow answer of either never holds
   * the rows back. Each is a status of its own: one that failed is asked again by an explicit
   * Retry, and one that answered is never read twice.
   */
  private fun loadMetadata(scope: CoroutineScope) {
    if (settingsLoad != SourceGroupLoad.Loading && !settled(settingsLoad)) {
      settingsLoad = SourceGroupLoad.Loading
      publish()
      scope.launch {
        val found = deadline(ADDON_GROUP_TIMEOUT_MS) { catalogApi.settings() }
        if (found == null) {
          settingsLoad = SourceGroupLoad.Failed
        } else {
          settingsValue = found
          settingsLoad = SourceGroupLoad.Empty
        }
        publish()
      }
    }
    if (addonsLoad != SourceGroupLoad.Loading && !settled(addonsLoad)) {
      addonsLoad = SourceGroupLoad.Loading
      publish()
      scope.launch {
        val found = deadline(ADDON_GROUP_TIMEOUT_MS) { catalogApi.addons() }
        if (found == null) {
          addonsLoad = SourceGroupLoad.Failed
        } else {
          addonList = found
          addonsLoad = SourceGroupLoad.Empty
        }
        publish()
      }
    }
  }

  private fun loadLocal(scope: CoroutineScope) {
    if (localLoad == SourceGroupLoad.Loading) return
    localLoad = SourceGroupLoad.Loading
    publish()
    scope.launch {
      val found = deadline(ADDON_GROUP_TIMEOUT_MS) { catalogApi.localStreams(type, id) }
      if (found == null) {
        localLoad = SourceGroupLoad.Failed
      } else {
        localRows = found
        localLoad = if (found.isEmpty()) SourceGroupLoad.Empty else SourceGroupLoad.Loaded
      }
      publish()
    }
  }

  private fun loadAddons(scope: CoroutineScope) {
    if (addonDiscovery == SourceGroupLoad.Loading) return
    if (settled(addonDiscovery)) {
      // The providers are named: a retry asks exactly the ones that owe an answer.
      providerList.forEach { provider -> if (!settled(providerLoads[provider.key])) loadProvider(scope, provider) }
      return
    }
    addonDiscovery = SourceGroupLoad.Loading
    publish()
    scope.launch {
      val found = deadline(ADDON_GROUP_TIMEOUT_MS) { catalogApi.streamSources(type, id) }
      if (found == null) {
        addonDiscovery = SourceGroupLoad.Failed
        publish()
        return@launch
      }
      // A provider that came back without a key names nothing to ask on its own, and an unfiltered
      // call would fan out into every addon at once: it is left out of the panel's providers.
      providerList = found.filter { it.key.isNotBlank() }
      providerLoads.clear()
      providerRows.clear()
      providerNotices.clear()
      providerList.forEach { providerLoads[it.key] = SourceGroupLoad.Idle }
      addonDiscovery = if (providerList.isEmpty()) SourceGroupLoad.Empty else SourceGroupLoad.Loaded
      publish()
      providerList.forEach { loadProvider(scope, it) }
    }
  }

  private fun loadProvider(scope: CoroutineScope, provider: StreamSourceDto) {
    val key = provider.key
    if (key.isBlank()) return
    if (providerLoads[key] == SourceGroupLoad.Loading) return
    providerLoads[key] = SourceGroupLoad.Loading
    publish()
    scope.launch {
      val found = addonPermits.withPermit {
        deadline(ADDON_GROUP_TIMEOUT_MS) { catalogApi.streams(type, id, key) }
      }
      if (found == null) {
        providerRows[key] = emptyList()
        providerLoads[key] = SourceGroupLoad.Failed
      } else {
        val attributed = found.map { attribute(provider, it) }
        // An addon's own message is kept beside the rows: it is a notice the viewer reads, never a
        // row to pick, and it is attributed to the provider that wrote it.
        providerNotices[key] = Streams.addonNotices(attributed)
        val rows = Streams.offeredStreams(attributed).filter { it.sourceId.isNotBlank() }
        providerRows[key] = rows
        providerLoads[key] = if (rows.isEmpty()) SourceGroupLoad.Empty else SourceGroupLoad.Loaded
      }
      publish()
    }
  }

  private fun loadRemotes(scope: CoroutineScope) {
    if (remoteDiscovery == SourceGroupLoad.Loading) return
    if (settled(remoteDiscovery)) {
      // The libraries are named: a retry asks exactly the ones that owe an answer.
      libraryList.forEach { library -> if (!settled(remoteLoads[library.id])) matchRemote(scope, library) }
      return
    }
    remoteDiscovery = SourceGroupLoad.Loading
    publish()
    scope.launch {
      val found = deadline(REMOTE_DISCOVERY_TIMEOUT_MS) { remoteApi.remoteLibraries() }
      if (found == null) {
        remoteDiscovery = SourceGroupLoad.Failed
        publish()
        return@launch
      }
      libraryList = found.filter { it.enabled && it.id != originLibraryId }
      remoteLoads.clear()
      remoteRows.clear()
      libraryList.forEach { remoteLoads[it.id] = SourceGroupLoad.Idle }
      remoteDiscovery = if (libraryList.isEmpty()) SourceGroupLoad.Empty else SourceGroupLoad.Loaded
      publish()
      libraryList.forEach { matchRemote(scope, it) }
    }
  }

  private fun matchRemote(scope: CoroutineScope, library: RemoteLibraryDto) {
    if (remoteLoads[library.id] == SourceGroupLoad.Loading) return
    remoteLoads[library.id] = SourceGroupLoad.Loading
    publish()
    scope.launch {
      val found = remotePermits.withPermit {
        deadline(REMOTE_MATCH_TIMEOUT_MS) {
          remoteApi.remoteMatchedStreams(library.id, type, id, nameHint)
        }
      }
      if (found == null) {
        remoteRows[library.id] = emptyList()
        remoteLoads[library.id] = SourceGroupLoad.Failed
      } else {
        val rows = Streams.offeredStreams(found)
        remoteRows[library.id] = rows
        remoteLoads[library.id] = if (rows.isEmpty()) SourceGroupLoad.Empty else SourceGroupLoad.Loaded
      }
      publish()
    }
  }

  /** A group that has an answer -- rows or an empty one -- keeps it; one still loading is not asked
   *  twice, so only a failure (or a group never asked) is owed another try. */
  private fun settled(load: SourceGroupLoad?): Boolean =
    load == SourceGroupLoad.Loaded || load == SourceGroupLoad.Empty

  private fun publish() {
    state = state.copy(
      settings = settingsValue,
      addons = addonList,
      realDebridConfigured = settingsValue.realDebridConfigured,
      local = localRows,
      addonRows = mergedAddonRows(),
      notices = mergedNotices(),
      remoteGroups = libraryList.mapNotNull { library ->
        remoteRows[library.id]?.takeIf { it.isNotEmpty() }
          ?.let { Streams.RemoteGroup(library.id, library.provider, library.name, it) }
      },
      asking = localLoad == SourceGroupLoad.Loading ||
        settingsLoad == SourceGroupLoad.Loading ||
        addonsLoad == SourceGroupLoad.Loading ||
        addonDiscovery == SourceGroupLoad.Loading ||
        remoteDiscovery == SourceGroupLoad.Loading ||
        providerLoads.values.any { it == SourceGroupLoad.Loading } ||
        remoteLoads.values.any { it == SourceGroupLoad.Loading },
      failedLabels = libraryList
        .filter { remoteLoads[it.id] == SourceGroupLoad.Failed }
        .map { listOf(it.provider, it.name).filter { name -> name.isNotBlank() }.joinToString(" · ") } +
        providerList.filter { providerLoads[it.key] == SourceGroupLoad.Failed }.map { it.name.ifBlank { it.key } },
      unnamedFailure = localLoad == SourceGroupLoad.Failed ||
        settingsLoad == SourceGroupLoad.Failed ||
        addonsLoad == SourceGroupLoad.Failed ||
        addonDiscovery == SourceGroupLoad.Failed ||
        remoteDiscovery == SourceGroupLoad.Failed,
    )
  }

  /** The addons' own messages, in the order the providers were named and one line per message. */
  private fun mergedNotices(): List<StreamDto> {
    val seen = LinkedHashSet<String>()
    return providerList.flatMap { providerNotices[it.key].orEmpty() }
      .filter { seen.add(Streams.noticeText(it)) }
  }

  /** Every loaded provider's rows in the order the providers were named, one row per source id. */
  private fun mergedAddonRows(): List<StreamDto> {
    val seen = HashSet<String>()
    return providerList.flatMap { providerRows[it.key].orEmpty() }
      .filter { it.sourceId.isNotBlank() && seen.add(it.sourceId) }
  }

  /** A row that arrived without naming its addon takes the provider's own key and name. */
  private fun attribute(provider: StreamSourceDto, stream: StreamDto): StreamDto = stream.copy(
    addonKey = stream.addonKey?.takeIf { it.isNotBlank() } ?: provider.key.takeIf { it.isNotBlank() },
    addonName = stream.addonName?.takeIf { it.isNotBlank() } ?: provider.name.takeIf { it.isNotBlank() },
  )

  /** A group call this list can live without: a failure is the empty answer, a cancellation is not. */
  private suspend fun <T> read(call: suspend () -> T): T? = try {
    call()
  } catch (cancelled: CancellationException) {
    throw cancelled
  } catch (_: ApiError) {
    null
  }

  private suspend fun <T> deadline(ms: Long, call: suspend () -> T): T? = read { withTimeoutOrNull(ms) { call() } }
}

/** One row the panel's Save action was pressed on, with the exact stream and the destinations read
 *  at that intent. The panel queues exactly this row. */
data class SourceSaveRequest(
  val stream: StreamDto,
  val subject: NativeCopySubject,
  val destinations: List<LibraryDto>,
  /** True when the row may hand the destination choice back to the server: an addon row's own
   *  storage rule. A media-server version always copies into an explicit destination. */
  val automatic: Boolean,
)

/**
 * The play one row of a Sources panel starts, or null when the row names nothing playable.
 *
 * A media-server row plays its own exact identity: its own item's stable key, its own incoming
 * context and only the versions of that same library item. A library copy plays the file on disk
 * under the file's own key. An addon row plays the title generically -- the catalogue key its
 * identity makes, with that identity's subtitles -- never the key of the native item or file it was
 * found under, and never the row's own opaque source id as a progress key.
 *
 * Every row carries [loaded], the whole list the panel holds, so the player offers exactly that
 * list and discovers nothing of its own; the title's own identity also travels as the subtitle
 * context, which is the generic key a switch inside the player keeps.
 */
internal fun nativeRowTarget(
  row: StreamDto,
  title: String,
  identity: Pair<String, String>?,
  loaded: List<StreamDto>,
  poster: String?,
): PlayTarget? {
  val remoteItem = row.remoteItem
  if (remoteItem != null) {
    return PlayTarget(
      key = identity?.let { ProgressKey.of(it.first, it.second) } ?: remoteItem.progressKey,
      title = title,
      resume = true,
      sourceId = row.sourceId.takeIf { it.isNotBlank() },
      stableKey = row.stableKey,
      poster = poster,
      subtitleType = identity?.first,
      subtitleTarget = identity?.second,
      remoteItem = remoteItem,
      remoteSources = Streams.remoteVersionsOf(remoteItem, loaded),
      initialSources = loaded,
    )
  }
  val path = row.localPath
  if (Streams.isLocalStream(row) && path != null) {
    return PlayTarget(
      key = Progress.libraryKey(path),
      title = title,
      resume = true,
      path = path,
      stableKey = row.stableKey,
      poster = poster,
      subtitleType = identity?.first,
      subtitleTarget = identity?.second,
      initialSources = loaded,
    )
  }
  val (type, requestId) = identity ?: return null
  return PlayTarget(
    key = ProgressKey.of(type, requestId),
    title = title,
    resume = true,
    sourceId = row.sourceId,
    stableKey = row.stableKey,
    poster = poster,
    subtitleType = type,
    subtitleTarget = requestId,
    catalogue = false,
    remoteItem = null,
    initialSources = loaded,
  )
}

/** The one copy in flight, kept in one object so the screen holds a single local. */
class SourceSaveState {
  var request by mutableStateOf<SourceSaveRequest?>(null)
  var resolving by mutableStateOf(false)
  var busy by mutableStateOf(false)
  /** A refusal from the last attempt, shown inside the open panel so the choice is kept. */
  var notice by mutableStateOf<String?>(null)
  /** True once a copy landed, so the detail says so without hiding the row the viewer picked. */
  var queued by mutableStateOf(false)
}

/**
 * The native detail's Sources panel: the item's own versions first and leading, then the rows the
 * supplementary groups gathered, drawn and filtered exactly as the catalogue detail draws its own
 * list. A group that is still out keeps the panel asking, a group that failed is a retryable note
 * beside the rows, and one exact row offers its own Save.
 */
@Composable
fun NativeSourcesPanel(
  state: NativeSourceState,
  /** The item's own versions: they lead whatever the supplementary groups answer. */
  originals: List<StreamDto>,
  /** The media-server library the item's own versions come from, so the source choice offers it and
   *  answers with exactly those rows. Null for a file on disk, whose own rows are copies. */
  originLibrary: Streams.RemoteGroup? = null,
  default: StreamDto?,
  chosen: StreamDto?,
  filters: Streams.StreamFilters,
  onFilterSelect: (chipKey: String, optionKey: String) -> Unit,
  onChoose: (StreamDto) -> Unit,
  onSave: ((StreamDto) -> Unit)?,
  canSave: (StreamDto) -> Boolean,
  onRetry: () -> Unit,
  emptyText: String,
  onClose: () -> Unit,
  initialFocus: FocusRequester?,
) {
  // The viewer's own copies, without the rows the detail already holds: a file the library answers
  // with is one row of the list, the detail's own, and never a second copy of itself.
  val localRows = remember(originals, state.local) {
    val seen = originals.mapTo(HashSet()) { Streams.rowIdentity(it) }
    Streams.deduped(state.local, seen)
  }
  // The item's own rows: they lead the recommended order, and a media-server item names the library
  // they belong to so the source choice can single them out.
  val originSources = remember(originals, originLibrary) {
    Streams.Origins(
      rows = originals,
      libraryId = originLibrary?.libraryId,
      label = originLibrary?.label.orEmpty(),
    )
  }
  val lists = remember(state, filters, localRows, originSources) {
    Streams.sourceLists(
      streams = state.addonRows,
      addons = state.addons,
      filters = filters,
      preferredLanguage = state.settings.audioLanguage ?: "en",
      showTorrents = state.realDebridConfigured,
      // A native item knows no catalogue metadata, so no title language stands in for an addon
      // that admitted it found none.
      metaLanguage = null,
      local = localRows,
      remote = state.remoteGroups,
      origins = originSources,
    )
  }
  val rows = lists.rows
  val total = originals.size + localRows.size + state.addonRows.size +
    state.remoteGroups.sumOf { it.streams.size }
  // The addons' own messages: the ones the coordinator kept beside the rows, plus any the shared
  // list found in its own input. Each is drawn once, and none of them is a row.
  val notices = remember(state.notices, lists.notices) {
    (state.notices + lists.notices).distinctBy { Streams.noticeText(it) }
  }
  val failedLabels = state.failedLabels
  val failureText = if (failedLabels.isEmpty()) {
    stringResource(R.string.media_server_error)
  } else {
    stringResource(R.string.media_server_group_failed, failedLabels.joinToString(", "))
  }
  val failedAnywhere = failedLabels.isNotEmpty() || state.unnamedFailure
  // A failure only stands in for the list when there is nothing to show; otherwise it is a note
  // beside the rows the viewer can already use.
  val failed = failedAnywhere && rows.isEmpty()
  SourcesPanel(
    streams = rows,
    focusIndex = rows.indexOfFirst { it === (chosen ?: default) }.coerceAtLeast(0),
    onChoose = onChoose,
    onClose = onClose,
    default = default,
    chosen = chosen,
    anyChosen = chosen != null,
    titleLanguage = lists.titleLanguage,
    asking = state.asking,
    failed = failed,
    notices = notices,
    emptyText = emptyText,
    failureText = failureText,
    onRetry = onRetry,
    retryTag = TagRemoteSourcesPanelRetry,
    filters = if (total > 1) sourceFilterChips(filters, lists.options) else emptyList(),
    onFilterSelect = onFilterSelect,
    countText = if (total > 1) stringResource(R.string.sources_of_total, rows.size, total) else null,
    remoteNote = if (!failed && failedAnywhere) failureText else null,
    onSaveToLibrary = onSave,
    canSaveToLibrary = canSave,
    initialFocus = initialFocus,
  )
}
