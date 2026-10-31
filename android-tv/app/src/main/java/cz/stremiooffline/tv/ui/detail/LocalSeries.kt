package cz.stremiooffline.tv.ui.detail

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.LibraryApi
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.playback.Progress
import cz.stremiooffline.tv.ui.catalog.episodeLine
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.CancellationException

/**
 * The viewer's place in a show on disk, drawn the way a media-server series is: the season chip
 * they chose and the episode Play, the source row and the tech block stand for. Both empty means
 * where the viewer left off: the last episode they started, or the one after it once finished.
 */
internal class LocalSeriesPick {
  var season by mutableStateOf<Int?>(null)
  var selectedPath by mutableStateOf<String?>(null)
  val seasons = FocusRequester()

  fun reset() {
    season = null
    selectedPath = null
  }

  /** The file Play acts on in a series detail; null for a film, which keeps its own choice. */
  fun chosen(detail: DetailData): BrowseItem.File? {
    if (!isEpisodeDetail(detail)) return null
    val episodes = episodeFiles(detail.files)
    episodes.firstOrNull { it.path == selectedPath }?.let { return it }
    val touched = episodes.indexOfLast { positionOf(it) > 0 }
    if (touched < 0) return episodes.firstOrNull()
    val last = episodes[touched]
    return if (isCompleted(last)) episodes.getOrNull(touched + 1) ?: last else last
  }
}

private fun episodeKey(file: BrowseItem.File): String =
  if (file.season != null && file.episode != null) "${file.season}:${file.episode}" else file.path

/** Every copy of the episode [file] is: the files carrying the same season and episode pair. */
internal fun copiesOf(files: List<BrowseItem.File>, file: BrowseItem.File): List<BrowseItem.File> {
  val key = episodeKey(file)
  return files.filter { episodeKey(it) == key }
}

/**
 * One card per episode, in season and episode order with the specials last: of several copies the
 * one last watched stands for it, else the largest, the way a media server folds its versions.
 */
internal fun episodeFiles(files: List<BrowseItem.File>): List<BrowseItem.File> =
  files.groupBy(::episodeKey).values
    .map { copies -> copies.maxWith(compareBy({ positionOf(it) > 0 }, { it.size })) }
    .sortedWith(
      compareBy<BrowseItem.File>(
        { if (it.season == 0) 1 else 0 },
        { it.season ?: Int.MAX_VALUE },
        { it.episode ?: Int.MAX_VALUE },
        { it.path },
      ),
    )

/** The ` (2)` a second copy of the same episode carries in its file name. */
private val CopySuffix = Regex("""\s*\(\d+\)$""")

private val EpisodeCodePrefix = Regex("""^.*?\b(?:S\d{1,3}\s*E\d{1,4}|\d{1,2}x\d{1,3})\b[\s._\-–—]*""", RegexOption.IGNORE_CASE)

/** The episode's own title read out of a file name such as `Show - S01E02 - Title`; null when the
 *  name holds nothing after its number. */
internal fun episodeTitleOf(file: BrowseItem.File): String? {
  val match = EpisodeCodePrefix.find(file.label) ?: return file.label.takeIf { file.season == null && file.episode == null }
  return file.label.substring(match.range.last + 1).replace(CopySuffix, "").trim().ifBlank { null }
}

internal fun episodeVideo(file: BrowseItem.File): VideoDto = VideoDto(
  id = file.path,
  title = episodeTitleOf(file),
  season = file.season,
  episode = file.episode,
  thumbnail = file.wide ?: file.poster,
)

/** The play one file starts: its own stored position resumes it. */
internal fun fileTarget(file: BrowseItem.File, resume: Boolean = true): PlayTarget = PlayTarget(
  Progress.libraryKey(file.path),
  file.label,
  resume = resume && Progress.resumePosition(positionOf(file), durationOf(file)) != null,
  path = file.path,
)

/** The episode line under a series' facts: the number pair and title of the episode Play plays. */
@Composable
internal fun LocalEpisodeLine(detail: DetailData, file: BrowseItem.File?) {
  if (file == null || !isEpisodeDetail(detail)) return
  Text(
    episodeLine(episodeVideo(file)),
    color = Tokens.Muted,
    fontSize = 11.5.sp,
    fontWeight = FontWeight.Medium,
  )
}

/** A show's seasons and its episodes, the same rows a media-server series draws. Enter plays the
 *  episode, Menu/Info opens its sources, and focusing a card makes it the one Play stands for. */
@Composable
internal fun LocalSeriesRows(
  detail: DetailData,
  pick: LocalSeriesPick,
  playing: BrowseItem.File?,
  imageUrl: (String?) -> String?,
  onPlay: (PlayTarget) -> Unit,
  onSources: (BrowseItem.File, FocusRequester) -> Unit,
  focusRequester: FocusRequester,
  extras: TitleExtrasState,
  onUpFromSeasons: () -> Boolean,
) {
  val episodes = remember(detail.files) { episodeFiles(detail.files) }
  val videos = remember(episodes) { episodes.map(::episodeVideo) }
  val byPath = remember(episodes) { episodes.associateBy { it.path } }
  SeriesRows(
    videos = videos,
    season = pick.season ?: playing?.season,
    onSeason = { season ->
      pick.season = season
      pick.selectedPath = episodes.firstOrNull { it.season == season }?.path
    },
    resumeEpisode = null,
    focusVideo = videos.firstOrNull { it.id == playing?.path },
    seriesPosition = 0.0,
    seriesDuration = 0.0,
    imageUrl = imageUrl,
    onSelect = { video -> byPath[video.id]?.let { onPlay(fileTarget(it)) } },
    focusRequester = focusRequester,
    seasonFocus = pick.seasons,
    extras = extras,
    onUpFromSeasons = onUpFromSeasons,
    onEpisodeFocused = { video -> pick.selectedPath = video.id },
    onMenu = { video -> byPath[video.id]?.let { onSources(it, focusRequester) } },
    cardTag = { video -> video.id.orEmpty() },
    cardProgress = { video -> byPath[video.id]?.let(::progressFraction) },
    cardCompleted = { video -> byPath[video.id]?.let(::isCompleted) == true },
  )
}

/**
 * Every video under a show's folder, its season folders included, read level by level the way the
 * library grid reads them. Null when a level could not be read, so the caller falls back to the
 * folder grid rather than draw half a show.
 */
internal suspend fun seriesFiles(api: LibraryApi, path: String, depth: Int = 0): List<BrowseItem.File>? {
  val found = ArrayList<BrowseItem.File>()
  var skip = 0
  while (true) {
    val page = try {
      api.browse(path, limit = SeriesPage, skip = skip)
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      return null
    }
    for (item in page.items) {
      when (item) {
        is BrowseItem.File -> found += item
        is BrowseItem.Folder -> if (depth < 3) found += seriesFiles(api, item.path, depth + 1) ?: return null
        else -> Unit
      }
    }
    skip += page.items.size
    if (page.items.isEmpty() || skip >= page.total || found.size >= 4000) break
  }
  return found
}

private const val SeriesPage = 120
