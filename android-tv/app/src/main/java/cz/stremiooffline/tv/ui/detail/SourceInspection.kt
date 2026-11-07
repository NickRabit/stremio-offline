package cz.stremiooffline.tv.ui.detail

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import cz.stremiooffline.tv.catalog.Streams
import cz.stremiooffline.tv.data.AudioFactsDto
import cz.stremiooffline.tv.data.CatalogApi
import cz.stremiooffline.tv.data.InspectionDto
import cz.stremiooffline.tv.data.InspectionTrackDto
import cz.stremiooffline.tv.data.StreamDto
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

data class DetectedTracks(
  val audio: List<String>,
  val audioKnown: Boolean,
  val subtitles: List<String>,
  val subtitlesKnown: Boolean,
  val noSubtitleTracks: Boolean,
  /** The file has sound tracks, but none of them names its language. */
  val audioUntagged: Boolean = false,
  /** The first sound track's codec and channels, as a library file's facts carry them. */
  val audioFacts: AudioFactsDto? = null,
  /** The picture's resolution class, read from the file. */
  val videoHeight: Int? = null,
)

private val READ_CODECS = setOf("aac", "ac3", "eac3", "dts", "truehd", "opus", "flac", "mp3")

/** The class a release would name: a 1920x800 scope picture is 1080p, not 800p. */
fun resolutionClass(width: Int?, height: Int?): Int? {
  if (height == null || height <= 0) return null
  val wide = width ?: 0
  return when {
    wide >= 3_200 || height >= 2_000 -> 2160
    wide >= 1_800 || height >= 1_000 -> 1080
    wide >= 1_200 || height >= 700 -> 720
    else -> height
  }
}

private fun languages(tracks: List<InspectionTrackDto>): List<String> =
  tracks.mapNotNull { it.language?.trim()?.takeIf(String::isNotEmpty) }.distinct()

fun detectedTracks(inspection: InspectionDto): DetectedTracks {
  val audio = languages(inspection.audioTracks)
  val subtitles = languages(inspection.subtitleTracks)
  val first = inspection.audioTracks.firstOrNull()
  return DetectedTracks(
    audio = audio,
    audioKnown = audio.isNotEmpty(),
    subtitles = subtitles,
    subtitlesKnown = inspection.subtitleTracks.isEmpty() || subtitles.isNotEmpty(),
    noSubtitleTracks = inspection.subtitleTracks.isEmpty(),
    audioUntagged = inspection.audioTracks.isNotEmpty() && audio.isEmpty(),
    audioFacts = first?.let {
      AudioFactsDto(codec = it.codec?.takeIf(READ_CODECS::contains), channels = it.channels?.takeIf { count -> count > 0 })
    },
    videoHeight = resolutionClass(inspection.video?.width, inspection.video?.height),
  )
}

sealed interface SourceInspection {
  data object Idle : SourceInspection
  data object Checking : SourceInspection
  data class Done(val tracks: DetectedTracks) : SourceInspection
}

class SourceInspectionState {
  var value by mutableStateOf<SourceInspection>(SourceInspection.Idle)
    internal set
}

@Composable
fun rememberSourceInspection(api: CatalogApi, stream: StreamDto?): SourceInspectionState {
  val sourceId = stream?.sourceId
  val state = remember(sourceId) { SourceInspectionState() }
  LaunchedEffect(state, sourceId) {
    state.value = SourceInspection.Idle
    val selected = stream?.takeIf(Streams::inspectable) ?: return@LaunchedEffect
    delay(500)
    state.value = SourceInspection.Checking
    try {
      val inspection = api.inspect(selected.sourceId)
      state.value = SourceInspection.Done(detectedTracks(inspection))
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: Exception) {
      state.value = SourceInspection.Idle
    }
  }
  return state
}

@Composable
fun InspectedTitleTechBlock(
  api: CatalogApi,
  stream: StreamDto,
  modifier: Modifier = Modifier,
  uiLanguage: String? = null,
  titleLanguage: String? = null,
  preferredLanguage: String? = null,
  versionCount: Int = 0,
) {
  val inspection = rememberSourceInspection(api, stream)
  TitleTechBlock(
    stream = stream,
    modifier = modifier,
    uiLanguage = uiLanguage,
    titleLanguage = titleLanguage,
    versionCount = versionCount,
    inspection = inspection.value,
    preferredLanguage = preferredLanguage,
  )
}
