package cz.stremiooffline.tv.ui.player

import cz.stremiooffline.tv.catalog.Streams
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.ui.catalog.OfferedSources
import cz.stremiooffline.tv.ui.detail.PlayTarget
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

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
    val path = target.path ?: return
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
    val lock = Mutex()
    fun publish() {
      val asking = addonsAsking || localAsking
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
      ).rows
      // Nothing has arrived yet: the panel is not offered a still-empty list, so the button does
      // not appear and disappear again around a title whose first source is slow.
      if (rows.isEmpty() && asking) return
      report(OfferedSources(rows, asking))
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
