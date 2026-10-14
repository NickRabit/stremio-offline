@file:OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.catalog.Streams
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.DownloadTargetDto
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.MediaDto
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteLibraryApi
import cz.stremiooffline.tv.data.RemoteProviderIdsDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.CancellationException

const val TagNativeQueuePanel = "native_queue_panel"
const val TagNativeQueueDenied = "native_queue_denied"
const val TagNativeQueueNoTargets = "native_queue_no_targets"

fun nativeQueueVersionTag(sourceId: String): String = "native_queue_version_$sourceId"
fun nativeQueueLibraryTag(id: String): String = "native_queue_library_$id"

/** One native item the viewer explicitly picked to copy, in the exact fields the queue's media
 *  object needs: an episode's title and catalogue ids come from its series, never from a filename. */
data class NativeCopySubject(
  val kind: String,
  val title: String,
  val year: Int? = null,
  val id: String? = null,
  val metaType: String? = null,
  val season: Int? = null,
  val episode: Int? = null,
  val episodeTitle: String? = null,
) {
  fun media(): MediaDto = MediaDto(
    kind = kind, title = title, year = year, id = id, metaType = metaType,
    season = season, episode = episode, episodeTitle = episodeTitle,
  )
}

private val IMDB_ID = Regex("^tt\\d+$")
private val TMDB_ID = Regex("^\\d+$")

/** The catalogue identity a provider row carries: a real IMDb id first, then a numeric TMDB id. */
fun catalogueIdentity(type: String, ids: RemoteProviderIdsDto): Pair<String, String>? {
  val imdb = ids.imdb
  if (imdb != null && IMDB_ID.matches(imdb)) return imdb to type
  val tmdb = ids.tmdb
  if (tmdb != null && TMDB_ID.matches(tmdb)) return "tmdb:$tmdb" to type
  return null
}

/** The subject of one exact native item. An episode takes its title and ids from the parent
 *  series; an item whose parent is unknown copies without an id rather than guessing one. */
fun nativeCopySubject(item: RemoteItemDto, seriesName: String?, seriesIds: RemoteProviderIdsDto?): NativeCopySubject =
  if (item.type == "episode") {
    val identity = seriesIds?.let { catalogueIdentity("series", it) }
    NativeCopySubject(
      kind = "episode",
      title = seriesName?.takeIf { it.isNotBlank() } ?: item.name,
      id = identity?.first,
      metaType = identity?.second,
      season = item.season,
      episode = item.episode,
      episodeTitle = item.name,
    )
  } else {
    val identity = catalogueIdentity("movie", item.providerIds)
    NativeCopySubject(
      kind = "movie",
      title = item.name,
      year = item.year,
      id = identity?.first,
      metaType = identity?.second,
    )
  }

/** What one version row reads: its own name and size, with a localized version number when two
 *  rows would otherwise read identically. An opaque source id is never a label. */
fun nativeVersionLabels(versions: List<StreamDto>, fallbackName: String, numbered: (Int) -> String): List<String> {
  val base = versions.map { stream ->
    val label = stream.name?.takeIf { it.isNotBlank() } ?: stream.title?.takeIf { it.isNotBlank() } ?: fallbackName
    formatSize(Streams.streamSize(stream))?.let { "$label · $it" } ?: label
  }
  val counts = base.groupingBy { it }.eachCount()
  return base.mapIndexed { index, label -> if ((counts[label] ?: 0) > 1) numbered(index + 1) else label }
}

private enum class Step { Version, Destination }

/** The last refusal, kept inside the panel so the viewer keeps their chosen version and library. */
@Composable
private fun PanelNotice(text: String?) {
  if (text == null) return
  Text(text, color = Tokens.Red, fontSize = 11.5.sp, fontWeight = FontWeight.Medium)
  Spacer(Modifier.height(2.dp))
}

/** Everything one explicit native copy needs, resolved once when the action is pressed. */
data class NativeCopyRequest(
  val subject: NativeCopySubject,
  val versions: List<StreamDto>,
  val destinations: List<LibraryDto>,
)

/** The target one native copy sends. The picked library is the destination the server projected
 *  for this exact version, so the copy carries no target and the server resolves its own
 *  configured subfolder and layout; any other library stays a deliberate override, sent as the
 *  existing target DTO. */
fun nativeQueueTarget(stream: StreamDto, libraryId: String): DownloadTargetDto? =
  if ((stream.downloadTarget?.libraryId ?: stream.downloadLibraryId) == libraryId) null else DownloadTargetDto(libraryId)

/** The job title one native copy carries: the film's name, or the series with the episode's number. */
fun nativeCopyTitle(subject: NativeCopySubject): String =
  if (subject.kind == "episode" && (subject.season != null || subject.episode != null)) {
    "${subject.title} · S${subject.season ?: 0} · E${subject.episode ?: 0}"
  } else {
    subject.title
  }

/**
 * Resolves one explicit copy: the parent series of an episode (read only because the viewer
 * pressed the action), the item's versions when the caller does not already hold them, and the
 * destinations this account may write to. A series that cannot be read leaves the copy without a
 * catalogue id rather than guessing one; a destination read that fails is the caller's to report.
 */
suspend fun resolveNativeCopy(
  api: RemoteLibraryApi,
  libraryId: String,
  item: RemoteItemDto,
  seriesName: String?,
  seriesIds: RemoteProviderIdsDto?,
  sources: List<StreamDto>?,
  loadDestinations: suspend () -> List<LibraryDto>,
): NativeCopyRequest {
  var name = seriesName
  var ids = seriesIds
  val seriesId = item.seriesId
  if (item.type == "episode" && ids == null && seriesId != null) {
    val parent = try {
      api.remoteItem(libraryId, seriesId).item
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      null
    }
    if (parent != null && parent.type == "series") {
      name = parent.name
      ids = parent.providerIds
    }
  }
  val versions = sources ?: api.remoteSources(libraryId, item.id)
  return NativeCopyRequest(
    subject = nativeCopySubject(item, name, ids),
    versions = versions,
    destinations = loadDestinations(),
  )
}

/**
 * The copy panel for one native item: the exact version first when more than one may be copied,
 * then the exact local destination. Nothing is queued without a destination this account can
 * write to, and [busy] holds every row and the Back key while the queue call is in flight.
 */
@Composable
fun NativeQueuePanel(
  versions: List<StreamDto>,
  /** The destinations this account may write to, already filtered to this kind. */
  libraries: List<LibraryDto>,
  /** The version the detail currently holds, offered first when it may be copied. */
  preferred: StreamDto?,
  /** True while the queue call is in flight: no row acts again and Back is held. */
  busy: Boolean = false,
  /** A refusal from the last attempt, shown inside the open panel so the choice is kept. */
  notice: String? = null,
  onQueue: (StreamDto, String) -> Unit,
  onClose: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val copyable = remember(versions) { versions.filter { Streams.canQueue(it, false) } }
  val initial = remember(copyable, preferred) {
    preferred?.takeIf { want -> copyable.any { it.sourceId == want.sourceId } }
      ?: copyable.maxByOrNull { Streams.streamSize(it) ?: -1.0 }
      ?: copyable.firstOrNull()
  }
  var chosenId by remember(copyable) { mutableStateOf(initial?.sourceId) }
  val chosen = copyable.firstOrNull { it.sourceId == chosenId } ?: initial
  var step by remember(copyable) { mutableStateOf(if (copyable.size > 1) Step.Version else Step.Destination) }
  // The destination the server projected for the version actually chosen leads; every other row
  // stays selectable.
  val defaultDestination = chosen?.downloadTarget?.libraryId ?: chosen?.downloadLibraryId
  val destinationIndex = remember(libraries, defaultDestination) {
    libraries.indexOfFirst { it.id == defaultDestination }.let { if (it >= 0) it else 0 }
  }

  val versionFocus = remember { FocusRequester() }
  val destinationFocus = remember { FocusRequester() }
  val close = { if (!busy) onClose() }

  if (copyable.isEmpty()) {
    SidePanel(
      title = stringResource(R.string.save_to_library),
      onClose = close,
      modifier = modifier.testTag(TagNativeQueuePanel),
      initialFocus = destinationFocus,
    ) {
      PanelNotice(notice)
      PanelOption(
        text = stringResource(R.string.media_server_download_disabled),
        onClick = close,
        modifier = Modifier.testTag(TagNativeQueueDenied).focusRequester(destinationFocus),
      )
    }
    return
  }

  if (step == Step.Version) {
    val context = LocalContext.current
    val labels = nativeVersionLabels(copyable, stringResource(R.string.tv_version)) { number ->
      // The catalogue's own text keeps the placeholder a string, so the number is handed over
      // as one.
      context.getString(R.string.media_server_version_number, number.toString())
    }
    SidePanel(
      title = stringResource(R.string.media_server_versions),
      onClose = close,
      modifier = modifier.testTag(TagNativeQueuePanel),
      initialFocus = versionFocus,
    ) {
      PanelNotice(notice)
      copyable.forEachIndexed { index, stream ->
        PanelOption(
          text = labels[index],
          selected = stream.sourceId == chosen?.sourceId,
          onClick = { if (!busy) { chosenId = stream.sourceId; step = Step.Destination } },
          modifier = Modifier
            .testTag(nativeQueueVersionTag(stream.sourceId))
            .then(if (index == 0) Modifier.focusRequester(versionFocus) else Modifier),
        )
      }
    }
    return
  }

  SidePanel(
    title = stringResource(R.string.save_to_library),
    onClose = { if (copyable.size > 1) { if (!busy) step = Step.Version } else close() },
    modifier = modifier.testTag(TagNativeQueuePanel),
    initialFocus = destinationFocus,
  ) {
    PanelNotice(notice)
    if (libraries.isEmpty()) {
      PanelOption(
        text = stringResource(R.string.save_target_no_library),
        onClick = close,
        modifier = Modifier.testTag(TagNativeQueueNoTargets).focusRequester(destinationFocus),
      )
    } else {
      libraries.forEachIndexed { index, library ->
        PanelOption(
          text = library.name,
          selected = index == destinationIndex,
          onClick = { if (!busy) chosen?.let { onQueue(it, library.id) } },
          modifier = Modifier
            .testTag(nativeQueueLibraryTag(library.id))
            .then(if (index == destinationIndex) Modifier.focusRequester(destinationFocus) else Modifier),
        )
      }
    }
  }
}
