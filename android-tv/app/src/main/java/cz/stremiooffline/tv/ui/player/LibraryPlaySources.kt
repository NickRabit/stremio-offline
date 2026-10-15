package cz.stremiooffline.tv.ui.player

import cz.stremiooffline.tv.catalog.Streams
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.ui.catalog.OfferedSources
import cz.stremiooffline.tv.ui.catalog.RemoteSourcesFailure
import cz.stremiooffline.tv.ui.detail.PlayTarget
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

/** The independent remote group deadlines of the library-bound loader. */
private const val REMOTE_DISCOVERY_TIMEOUT_MS = 3_000L
private const val REMOTE_MATCH_TIMEOUT_MS = 8_000L

/**
 * The sources a play that started from the library offers. A file bound to a catalogue title is
 * asked about that title -- the local copies the catalogue detail would show, and every addon
 * stream it would list -- so the player can switch between them the way it does for a play the
 * catalogue started. A file with no binding has nothing to ask the addons about and reports
 * nothing at all, leaving the Sources button away.
 *
 * The list is built the way `CatalogDetailScreen` builds its own and reported as it grows, so the
 * panel shows the local copy and the first addon while the rest still answer. It is merged only
 * when an answer lands, never on a focus move.
 */
class LibraryPlaySources(private val api: TvApi) {

  /** Loads the offered rows of [target] and reports them until the last addon answered. A
   *  cancelled caller stops the loading; nothing is reported for a catalogue play, a target
   *  without a path, an unbound file or a failed lookup. */
  suspend fun load(target: PlayTarget, report: (OfferedSources) -> Unit) {
    // A target that already carries its own addon rows must not discover anything else.
    if (target.initialSources != null) return
    val path = target.path ?: return
    // A native media-server play offers its own remote versions; nothing in the filesystem or the
    // addon machinery is asked about it.
    if (target.remoteItem != null) return
    if (target.catalogue) return
    val title = read { api.libraryTitle(path) } ?: return
    if (title.id.isBlank()) return
    val type = title.type
    // An episode is asked for the id the addon stream endpoint takes, which is the video's own.
    val id = title.videoId?.takeIf { it.isNotBlank() } ?: title.id
    val settings = read { api.settings() } ?: SettingsResponse()
    val addons = read { api.addons() }.orEmpty()
    val filters = Streams.StreamFilters(sort = Streams.StreamSort.of(settings.streamSort))
    val streams = mutableListOf<StreamDto>()
    val local = mutableListOf<StreamDto>()
    // Both halves are asked in parallel, and the panel says it is asking until the last of them
    // answered: an empty state before then would deny a source that is still on its way.
    var addonsAsking = true
    var localAsking = true
    var remoteAsking = true
    var remoteDiscoveryFailed = false
    // Remote groups keep the configured library order whatever order their answers arrive in.
    val remoteById = mutableMapOf<String, Streams.RemoteGroup>()
    val remoteGroups = mutableListOf<Streams.RemoteGroup>()
    val remoteFailedLabels = mutableListOf<String>()
    val lock = Mutex()
    fun publish() {
      val asking = addonsAsking || localAsking || remoteAsking
      val rows = Streams.sourceLists(
        streams = streams.toList(),
        addons = addons,
        filters = filters,
        preferredLanguage = settings.audioLanguage ?: "en",
        showTorrents = settings.realDebridConfigured,
        // A library play knows no catalogue metadata, so no title language stands in for an
        // addon that admitted it found none.
        metaLanguage = null,
        local = local.toList(),
        remote = remoteGroups.toList(),
      ).rows
      val failure = when {
        remoteDiscoveryFailed -> RemoteSourcesFailure(discovery = true)
        remoteFailedLabels.isNotEmpty() -> RemoteSourcesFailure(remoteFailedLabels.toList())
        else -> null
      }
      // Nothing has arrived yet: the panel is not offered a still-empty list, so the button does
      // not appear and disappear again around a title whose first source is slow.
      if (rows.isEmpty() && asking && failure == null) return
      report(OfferedSources(rows, asking, failure))
    }
    coroutineScope {
      // The local lookup is its own child, started before the addons are asked, so a failed
      // addon discovery neither cancels it nor skips it.
      launch {
        val found = read { api.localStreams(type, id) }.orEmpty()
        lock.withLock {
          local += found
          localAsking = false
          publish()
        }
      }
      // The remote groups are their own child, so a slow or offline media server never holds the
      // local copy or the addons back, and they publish the moment a group answers.
      launch {
        val libraries = try {
          withTimeoutOrNull(REMOTE_DISCOVERY_TIMEOUT_MS) { api.remoteLibraries() }
        } catch (cancelled: CancellationException) {
          throw cancelled
        } catch (_: ApiError) {
          null
        }
        if (libraries == null) {
          lock.withLock { remoteDiscoveryFailed = true; remoteAsking = false; publish() }
          return@launch
        }
        if (libraries.isEmpty()) {
          lock.withLock { remoteAsking = false; publish() }
          return@launch
        }
        var remaining = libraries.size
        coroutineScope {
          libraries.forEach { library ->
            launch {
              val part = try {
                // The bound catalogue title's own name is the provider's filter hint; for an
                // episode that is the series name, because the binding names the series.
                withTimeoutOrNull(REMOTE_MATCH_TIMEOUT_MS) { api.remoteMatchedStreams(library.id, type, id, nameHint = title.name) }
              } catch (cancelled: CancellationException) {
                throw cancelled
              } catch (_: ApiError) {
                null
              }
              lock.withLock {
                if (part != null && part.isNotEmpty()) {
                  remoteById[library.id] = Streams.RemoteGroup(library.id, library.provider, library.name, part)
                } else if (part == null) {
                  remoteFailedLabels += listOf(library.provider, library.name).filter { it.isNotBlank() }.joinToString(" · ")
                }
                remoteGroups.clear()
                remoteGroups += libraries.mapNotNull { remoteById[it.id] }
                remaining -= 1
                if (remaining == 0) remoteAsking = false
                publish()
              }
            }
          }
        }
      }
      val sources = read { api.streamSources(type, id) }.orEmpty()
      var pending = sources.size
      lock.withLock {
        if (pending == 0) addonsAsking = false
        publish()
      }
      coroutineScope {
        sources.forEach { source ->
          launch {
            val part = read { api.streams(type, id, source.key.ifEmpty { null }) }.orEmpty()
            // Addon answers can resume on different threads, so their updates take a lock: a lost
            // decrement would leave the panel asking forever.
            lock.withLock {
              if (part.isNotEmpty()) streams += part
              pending -= 1
              if (pending == 0) addonsAsking = false
              publish()
            }
          }
        }
      }
    }
  }

  /** A call this list can live without: a failure is the empty answer, a cancellation is not. */
  private suspend fun <T> read(call: suspend () -> T): T? = try {
    call()
  } catch (cancelled: CancellationException) {
    throw cancelled
  } catch (error: ApiError) {
    null
  }
}
