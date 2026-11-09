package cz.stremiooffline.tv.ui.player

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.PlaybackChapterDto
import cz.stremiooffline.tv.playback.chapterAt
import cz.stremiooffline.tv.playback.chapterLabelOf
import cz.stremiooffline.tv.ui.catalog.PanelOption
import cz.stremiooffline.tv.ui.catalog.SidePanel

const val TagChaptersPanel = "chapters_panel"

fun chapterRowTag(index: Int): String = "chapter_row_$index"

@Composable
fun PlayerChaptersPanel(
  chapters: List<PlaybackChapterDto>,
  position: Double,
  onSeek: (Double) -> Unit,
  onClose: () -> Unit,
  initialFocus: FocusRequester? = null,
) {
  val current = chapterAt(chapters, position).takeIf { it >= 0 } ?: 0
  SidePanel(
    title = stringResource(R.string.player_chapters),
    onClose = onClose,
    modifier = Modifier.testTag(TagChaptersPanel),
    initialFocus = initialFocus,
  ) {
    chapters.forEachIndexed { index, chapter ->
      val numbered = stringResource(R.string.player_chapter_number, index + 1)
      val label = chapterLabelOf(chapters, index) { numbered }
      PanelOption(
        text = "$label \u00b7 ${playbackClock(chapter.start)}",
        selected = index == current,
        onClick = {
          onSeek(chapter.start)
          onClose()
        },
        modifier = Modifier
          .testTag(chapterRowTag(index))
          .then(if (index == current && initialFocus != null) Modifier.focusRequester(initialFocus) else Modifier),
      )
    }
  }
}

