package cz.stremiooffline.tv.ui.catalog

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import cz.stremiooffline.tv.catalog.Streams
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.CatalogApi
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteProviderIdsDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.StreamSourceDto
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * The `(type, id)` pair the addon stream endpoints take for one native item, or null when no
 * request can be derived from it.
 *
 * A movie uses its own catalogue identity. An episode uses ONLY its parent series' identity plus
 * its own `:season:episode` suffix: the episode's own ids name nothing the endpoints accept, and
 * an opaque series id, a tvdb-only identity or an unknown one is no identity at all. A series,
 * season or folder has no derivation, and a missing parent identity is never looked up here -- the
 * caller hands over whatever parent data it already holds.
 */
fun nativeAddonIdentity(item: RemoteItemDto, seriesIds: RemoteProviderIdsDto?): Pair<String, String>? = when (item.type) {
  "movie" -> catalogueIdentity("movie", item.providerIds)?.let { (id, type) -> type to id }
  "episode" -> {
    val season = item.season
    val episode = item.episode
    val parent = seriesIds?.let { catalogueIdentity("series", it) }
    if (season == null || episode == null || season < 0 || episode < 1 || parent == null) null
    else parent.second to "${parent.first}:$season:$episode"
  }
  else -> null
}

/** Where the explicit discovery of one item's providers stands. */
enum class AddonDiscovery { Idle, Loading, Failed, Empty, Ready }

/** Where one provider's explicit load stands. */
enum class AddonProviderLoad { Loading, Failed, Empty, Loaded }

/** One provider and what its explicit load left behind. */
data class AddonProviderState(
  val key: String,
  val name: String,
  val load: AddonProviderLoad,
  val streams: List<StreamDto> = emptyList(),
) {
  val label: String get() = name.ifBlank { key }
}

/**
 * The explicit, per-item addon discovery behind the native detail's Sources panel. Nothing is
 * asked of the addons until the viewer presses: the account settings and the provider list are
 * read on the discovery press, and each provider's own key is loaded on its own press. The state
 * lives with the item, so closing and reopening the panel reuses it; it is remade -- with its
 * jobs cancelled by the caller -- when the item changes, and no arrival ever touches another
 * item's rows. Nothing is cached beyond this object.
 */
class NativeAddonSources(private val api: CatalogApi, private val identity: Pair<String, String>) {
  var discovery by mutableStateOf(AddonDiscovery.Idle)
    private set
  var providers by mutableStateOf<List<StreamSourceDto>>(emptyList())
    private set
  /** The loaded addon rows: deduped by a nonblank source id, largest first. */
  var rows by mutableStateOf<List<StreamDto>>(emptyList())
    private set
  /** Read with the discovery, so a torrent row is only queueable when the account has debrid. */
  var realDebridConfigured by mutableStateOf(false)
    private set

  private val states = mutableStateMapOf<String, AddonProviderState>()
  private val pending = mutableSetOf<String>()
  private var discovering = false

  val type: String get() = identity.first
  val id: String get() = identity.second

  fun providerState(key: String): AddonProviderState? = states[key]

  /** Reads the provider list once the viewer asks for it. A second press while one call is out is
   *  dropped rather than answered with a second call. */
  fun discover(scope: CoroutineScope) {
    if (discovering) return
    discovering = true
    discovery = AddonDiscovery.Loading
    scope.launch {
      try {
        read { api.settings() }?.let { realDebridConfigured = it.realDebridConfigured }
        val found = api.streamSources(type, id)
        providers = found
        discovery = if (found.isEmpty()) AddonDiscovery.Empty else AddonDiscovery.Ready
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        discovery = AddonDiscovery.Failed
      } finally {
        discovering = false
      }
    }
  }

  /** Loads exactly one provider's key, and only that key. A press while that provider is already
   *  in flight is dropped, so two quick presses share one call. */
  fun loadProvider(scope: CoroutineScope, key: String) {
    val provider = providers.firstOrNull { it.key == key } ?: return
    if (!pending.add(key)) return
    states[key] = AddonProviderState(provider.key, provider.name, AddonProviderLoad.Loading)
    scope.launch {
      try {
        val found = api.streams(type, id, key).map { attribute(provider, it) }
        val offered = Streams.offeredStreams(found).filter { it.sourceId.isNotBlank() }
        states[key] = AddonProviderState(
          provider.key,
          provider.name,
          if (offered.isEmpty()) AddonProviderLoad.Empty else AddonProviderLoad.Loaded,
          offered,
        )
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        states[key] = AddonProviderState(provider.key, provider.name, AddonProviderLoad.Failed)
      } finally {
        pending.remove(key)
        recomputeRows()
      }
    }
  }

  private fun recomputeRows() {
    val seen = HashSet<String>()
    val merged = providers.flatMap { states[it.key]?.streams.orEmpty() }
      .filter { it.sourceId.isNotBlank() && seen.add(it.sourceId) }
    rows = merged.sortedWith(compareByDescending { Streams.streamSize(it) ?: Double.NEGATIVE_INFINITY })
  }

  /** A row that arrived without naming its addon takes the chosen provider's own key and name. */
  private fun attribute(provider: StreamSourceDto, stream: StreamDto): StreamDto = stream.copy(
    addonKey = stream.addonKey?.takeIf { it.isNotBlank() } ?: provider.key.takeIf { it.isNotBlank() },
    addonName = stream.addonName?.takeIf { it.isNotBlank() } ?: provider.name.takeIf { it.isNotBlank() },
  )

  private suspend fun <T> read(call: suspend () -> T): T? = try {
    call()
  } catch (cancelled: CancellationException) {
    throw cancelled
  } catch (_: ApiError) {
    null
  }
}

/** One addon row the viewer pressed Save on, with the exact stream and destinations read at that
 *  intent. The panel queues exactly this row. */
data class AddonSaveRequest(
  val stream: StreamDto,
  val subject: NativeCopySubject,
  val destinations: List<LibraryDto>,
)

/** The one addon copy in flight, kept in one object so the screen keeps a single local. */
class AddonSaveState {
  var request by mutableStateOf<AddonSaveRequest?>(null)
  var resolving by mutableStateOf(false)
  var busy by mutableStateOf(false)
  /** A refusal from the last attempt, shown inside the open panel so the choice is kept. */
  var notice by mutableStateOf<String?>(null)
  /** True once a copy landed, so the detail says so without hiding the row the viewer picked. */
  var queued by mutableStateOf(false)
}
