package cz.stremiooffline.tv.ui.detail

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import coil.compose.AsyncImage
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.playback.Progress
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.WideCard
import cz.stremiooffline.tv.ui.theme.Tokens
import java.util.Locale

const val TagDetailPrimary = "detail_primary"
const val TagDetailStartOver = "detail_start_over"
const val TagDetailWatched = "detail_watched"

/**
 * What to play: the progress key and title, and either a library [path] to mint a source from or
 * a catalogue [sourceId] the server already handed out. The player skips `librarySource()` when a
 * source id is present.
 */
data class PlayTarget(
  val key: String,
  val title: String,
  val resume: Boolean,
  val path: String? = null,
  val sourceId: String? = null,
)

/** Everything the title detail draws: the artwork, the meta line and the files that sit under it. */
data class DetailData(
  val gridPath: String,
  val title: String,
  val year: String?,
  val description: String?,
  val poster: String?,
  val wide: String?,
  val size: Double,
  val fileCount: Int,
  val files: List<BrowseItem.File>,
) {
  /** Re-reads the stored position of every file, so returning from the player shows the resume. */
  suspend fun refresh(progress: suspend (String) -> ProgressDto?): DetailData {
    val refreshed = files.map { file ->
      val stored = runCatching { progress(Progress.libraryKey(file.path)) }.getOrNull()
      if (stored == null) file else file.copy(progress = stored)
    }
    return copy(files = refreshed)
  }

  companion object {
    fun ofFolder(folder: BrowseItem.Folder, files: List<BrowseItem.File>) = DetailData(
      gridPath = folder.path,
      title = folder.name,
      year = folder.year,
      description = folder.description,
      poster = folder.poster,
      wide = folder.wide,
      size = folder.size,
      fileCount = folder.fileCount,
      files = files,
    )

    fun ofFile(file: BrowseItem.File) = DetailData(
      gridPath = file.path,
      title = file.label,
      year = file.year,
      description = file.description,
      poster = file.poster,
      wide = file.wide,
      size = file.size,
      fileCount = 1,
      files = listOf(file),
    )
  }
}

/** The episode label of one file: `S1 · E2` when the server numbered it, its label otherwise. */
fun episodeLabel(file: BrowseItem.File): String =
  if (file.season != null && file.episode != null) "S${file.season} · E${file.episode}" else file.label

@Composable
fun DetailScreen(
  detail: DetailData,
  imageUrl: (String?) -> String?,
  onPlay: (PlayTarget) -> Unit,
  onBack: () -> Unit,
  progress: suspend (String) -> ProgressDto?,
  restoreToken: Int = 0,
  backEnabled: Boolean = true,
) {
  BackHandler(enabled = backEnabled) { onBack() }

  // The stored positions are re-read on every entry and when the player returns, so the detail
  // never keeps a stale "Play" after a title was watched.
  var current by remember { mutableStateOf(detail) }
  LaunchedEffect(detail.gridPath, restoreToken) {
    current = if (detail.files.isEmpty()) detail else detail.refresh(progress)
  }

  val playIndex = current.files.indexOfFirst { !isCompleted(it) }.let { if (it < 0) 0 else it }
  val playFile = current.files.getOrNull(playIndex)
  val resuming = playFile?.let { Progress.resumePosition(positionOf(it), durationOf(it)) != null } == true

  val primaryFocus = remember { FocusRequester() }
  val rowFocus = remember { FocusRequester() }
  // The primary action takes focus on the first entry and again when the player closes.
  LaunchedEffect(current.gridPath, restoreToken) {
    runCatching { primaryFocus.requestFocus() }
  }


  Box(
    Modifier
      .fillMaxSize()
      .background(Tokens.Bg)
      // DOWN from the actions enters the episode row on the first episode that is not finished,
      // not on whatever card happens to sit below the button.
      .onPreviewKeyEvent { event ->
        if (event.type == KeyEventType.KeyDown && event.key == Key.DirectionDown && current.files.size > 1) {
          runCatching { rowFocus.requestFocus() }
          true
        } else {
          false
        }
      },
  ) {
    AsyncImage(
      model = imageUrl(current.wide ?: current.poster),
      contentDescription = null,
      contentScale = ContentScale.Crop,
      modifier = Modifier.fillMaxSize(),
    )
    Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(listOf(Tokens.Bg, Tokens.Bg.copy(alpha = 0.8f), Tokens.Bg.copy(alpha = 0f)))))
    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Tokens.Bg.copy(alpha = 0f), Tokens.Bg.copy(alpha = 0.6f), Tokens.Bg))))

    Column(
      modifier = Modifier.fillMaxSize().padding(start = 60.dp, top = Tokens.SafeY, end = 60.dp),
      verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
      Text(
        stringResource(R.string.tv_detail_eyebrow_library).uppercase(),
        color = Tokens.Accent,
        fontSize = 10.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 1.8.sp,
      )
      Text(
        current.title,
        color = Tokens.Text,
        fontSize = 42.sp,
        fontWeight = FontWeight.ExtraBold,
        letterSpacing = (-1.2).sp,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.width(760.dp),
      )
      Text(
        metaLine(current, stringResource(R.string.tv_library_files, current.fileCount.toString())),
        color = Tokens.Muted,
        fontSize = 11.5.sp,
        fontWeight = FontWeight.Medium,
      )
      val description = current.description
      if (description != null) {
        Text(
          description,
          color = Tokens.Text.copy(alpha = 0.82f),
          fontSize = 12.5.sp,
          lineHeight = 18.sp,
          maxLines = 3,
          overflow = TextOverflow.Ellipsis,
          modifier = Modifier.width(700.dp),
        )
      }
      if (resuming) {
        val fraction = (positionOf(playFile) / (durationOf(playFile).takeIf { it > 0 } ?: 1.0)).toFloat()
        val percent = (fraction * 100).toInt()
        Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
          Box(
            Modifier.width(140.dp).height(5.dp).clip(RoundedCornerShape(999.dp)).background(Tokens.Line),
          ) {
            Box(
              Modifier
                .fillMaxHeight()
                .fillMaxWidth(fraction.coerceIn(0f, 1f))
                .background(Tokens.Accent)
            )
          }
          Text(
            stringResource(R.string.tv_detail_watched, percent.toString()),
            color = Tokens.Muted,
            fontSize = 10.sp,
            modifier = Modifier.testTag(TagDetailWatched),
          )
        }
      }
      Spacer(Modifier.height(3.dp))
      Row(horizontalArrangement = Arrangement.spacedBy(11.dp), verticalAlignment = Alignment.CenterVertically) {
        FocusButton(
          text = stringResource(if (resuming) R.string.tv_resume else R.string.tv_play),
          onClick = { playFile?.let { onPlay(PlayTarget(Progress.libraryKey(it.path), it.label, resume = resuming, path = it.path)) } },
          kind = FocusButtonKind.Primary,
          modifier = Modifier.focusRequester(primaryFocus).testTag(TagDetailPrimary),
        )
        if (resuming) {
          FocusButton(
            text = stringResource(R.string.tv_start_over),
            onClick = { playFile?.let { onPlay(PlayTarget(Progress.libraryKey(it.path), it.label, resume = false, path = it.path)) } },
            modifier = Modifier.testTag(TagDetailStartOver),
          )
        }
      }
      if (current.files.size > 1) {
        Spacer(Modifier.height(3.dp))
        EpisodeRow(
          detail = current,
          startIndex = playIndex,
          imageUrl = imageUrl,
          onPlay = onPlay,
          focusRequester = rowFocus,
        )
      }
    }
  }
}

@Composable
private fun EpisodeRow(
  detail: DetailData,
  startIndex: Int,
  imageUrl: (String?) -> String?,
  onPlay: (PlayTarget) -> Unit,
  focusRequester: FocusRequester,
) {
  val state = rememberLazyListState()
  LaunchedEffect(detail.gridPath) {
    state.scrollToItem(startIndex.coerceAtLeast(0))
  }
  LazyRow(state = state, horizontalArrangement = Arrangement.spacedBy(18.dp)) {
    itemsIndexed(detail.files, key = { _, file -> file.path }) { index, file ->
      WideCard(
        label = episodeLabel(file),
        imageUrl = imageUrl(file.wide ?: file.poster),
        progress = progressFraction(file),
        completed = isCompleted(file),
        cardTag = file.path,
        onClick = {
          val resume = Progress.resumePosition(positionOf(file), durationOf(file)) != null
          onPlay(PlayTarget(Progress.libraryKey(file.path), file.label, resume = resume, path = file.path))
        },
        modifier = if (index == startIndex) Modifier.focusRequester(focusRequester) else Modifier,
      )
    }
  }
}

private fun metaLine(detail: DetailData, files: String): String {
  val parts = mutableListOf<String>()
  detail.year?.takeIf { it.isNotBlank() }?.let(parts::add)
  if (detail.fileCount > 0) parts.add(files)
  formatSize(detail.size)?.let(parts::add)
  return parts.joinToString(" · ")
}

/** The web's size units: bytes into MB under a gigabyte, GB above it. */
private fun formatSize(size: Double): String? = when {
  size >= 1e9 -> String.format(Locale.US, "%.1f GB", size / 1e9)
  size >= 1e6 -> String.format(Locale.US, "%.0f MB", size / 1e6)
  size > 0 -> String.format(Locale.US, "%.0f kB", size / 1e3)
  else -> null
}

private fun positionOf(file: BrowseItem.File?): Double = file?.progress?.position ?: 0.0

private fun durationOf(file: BrowseItem.File?): Double = file?.progress?.duration ?: 0.0

private fun isCompleted(file: BrowseItem.File): Boolean = Progress.isCompleted(positionOf(file), durationOf(file))

private fun progressFraction(file: BrowseItem.File): Float? {
  val duration = durationOf(file)
  if (duration <= 0 || positionOf(file) <= 0) return null
  return (positionOf(file) / duration).toFloat()
}
