@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import androidx.activity.ComponentActivity
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.requestFocus
import cz.stremiooffline.tv.data.AddonSubtitleDto
import cz.stremiooffline.tv.data.LibraryTitleDto
import cz.stremiooffline.tv.data.NextFileDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.playback.Progress
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Bug on the emulator: the next episode played with the ended episode's name on the OSD, because
 * only the controller learned the new title. The screen's title follows it too.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerScreenNextTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private val api = FakeTvApi().apply {
    startAnswer = PlaybackDescriptorDto(id = "p1", url = "/stream.mp4", duration = 600.0)
    libraryNextValue = NextFileDto(path = "Films/B.mkv", title = "B \u00b7 S1 \u00b7 E2")
  }

  @Test
  fun `the OSD names the next episode once it starts`() {
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(
          key = Progress.libraryKey("Films/A.mkv"),
          title = "A \u00b7 S1 \u00b7 E1",
          resume = false,
          path = "Films/A.mkv",
        ),
        onExit = {},
      )
    }
    compose.waitForIdle()
    compose.waitUntil(5_000) { api.libraryNextRequests.isNotEmpty() }
    compose.onNodeWithText("A \u00b7 S1 \u00b7 E1").assertExists()

    compose.onNodeWithTag(TAG_OSD_NEXT).requestFocus()
    compose.onNodeWithTag(TAG_OSD_NEXT).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    compose.onNodeWithText("B \u00b7 S1 \u00b7 E2").assertExists()
  }

  @Test
  fun `the next episode asks for its own addon subtitles and starts without the old ones`() {
    api.libraryTitleValues["Films/A.mkv"] = LibraryTitleDto(type = "series", id = "tt9", videoId = "tt9:1:1")
    api.libraryTitleValues["Films/B.mkv"] = LibraryTitleDto(type = "series", id = "tt9", videoId = "tt9:1:2")
    api.subtitlesValue = listOf(AddonSubtitleDto(subtitleId = "minted", lang = "cs", addonName = "OpenSubtitles"))
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(
          key = Progress.libraryKey("Films/A.mkv"),
          title = "A \u00b7 S1 \u00b7 E1",
          resume = false,
          path = "Films/A.mkv",
        ),
        onExit = {},
      )
    }
    compose.waitUntil(5_000) { api.libraryNextRequests.isNotEmpty() && api.subtitlesRequests.isNotEmpty() }
    compose.waitForIdle()

    compose.onNodeWithTag(TAG_OSD_NEXT).requestFocus()
    compose.onNodeWithTag(TAG_OSD_NEXT).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitUntil(5_000) { api.startedSources.size == 2 && api.subtitlesRequests.size == 2 }

    assertEquals(listOf("series" to "tt9:1:1", "series" to "tt9:1:2"), api.subtitlesRequests)
    assertEquals(emptyList<String>(), api.startedSubtitleIds.last())
  }
}
