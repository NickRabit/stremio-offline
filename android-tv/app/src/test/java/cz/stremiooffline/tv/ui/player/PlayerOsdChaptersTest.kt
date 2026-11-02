@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import androidx.activity.ComponentActivity
import androidx.compose.ui.input.key.Key
import androidx.compose.runtime.remember
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.PlaybackChapterDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerOsdChaptersTest {
  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private val chapters = listOf(
    PlaybackChapterDto(0.0, 600.0, "Opening"),
    PlaybackChapterDto(600.0, 1800.0),
    PlaybackChapterDto(1800.0, 3600.0, "Finale"),
  )

  private fun mount(items: List<PlaybackChapterDto> = chapters): FakeTvApi {
    val answer = PlaybackDescriptorDto(
      id = "p1",
      url = "/stream.m3u8",
      playlist = true,
      duration = 3600.0,
      chapters = items,
    )
    val api = FakeTvApi().apply {
      startAnswer = answer
      seekAnswer = answer
    }
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(key = "movie:tt12345", title = "It", resume = false, sourceId = "src1"),
        onExit = {},
      )
    }
    compose.waitForIdle()
    return api
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun openChapters() {
    press(Key.DirectionRight)
    press(Key.DirectionRight)
    press(Key.DirectionRight)
    press(Key.DirectionRight)
    compose.onNodeWithTag(TAG_OSD_CHAPTERS).assertIsFocused()
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagChaptersPanel).assertExists()
  }

  @Test
  fun `the timeline marks chapters and names the current one`() {
    mount()

    assertEquals(2, compose.onAllNodesWithTag(TAG_OSD_CHAPTER_MARK).fetchSemanticsNodes().size)
    compose.onNodeWithTag(TAG_OSD_CHAPTER).assertTextEquals("Opening")
  }

  @Test
  fun `the chapters button is hidden below two chapters`() {
    mount(listOf(PlaybackChapterDto(0.0, 3600.0, "Whole")))

    compose.onNodeWithTag(TAG_OSD_CHAPTERS).assertDoesNotExist()
  }

  @Test
  fun `OK on the third row seeks and returns focus to the chapters button`() {
    mount()
    openChapters()
    compose.onNodeWithTag(chapterRowTag(0)).assertIsFocused()

    press(Key.DirectionDown)
    press(Key.DirectionDown)
    compose.onNodeWithTag(chapterRowTag(2)).assertIsFocused()
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagChaptersPanel).assertDoesNotExist()
    compose.onNodeWithTag(TAG_OSD_CHAPTERS).assertIsFocused()
  }

  @Test
  fun `OK on the third chapter row seeks to its start`() {
    var seek: Double? = null
    compose.setContent {
      val entry = remember { FocusRequester() }
      PlayerChaptersPanel(
        chapters = chapters,
        position = 0.0,
        onSeek = { seek = it },
        onClose = {},
        initialFocus = entry,
      )
    }
    compose.waitForIdle()

    press(Key.DirectionDown)
    press(Key.DirectionDown)
    compose.onNodeWithTag(chapterRowTag(2)).assertIsFocused()
    press(Key.DirectionCenter)

    assertEquals(1800.0, seek)
  }

  @Test
  fun `Back closes the panel and returns focus to the chapters button`() {
    mount()
    openChapters()

    compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()

    compose.onNodeWithTag(TagChaptersPanel).assertDoesNotExist()
    compose.onNodeWithTag(TAG_OSD_CHAPTERS).assertIsFocused()
  }
}
