package cz.stremiooffline.tv.ui.player

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.ui.detail.DetailData
import cz.stremiooffline.tv.ui.detail.DetailScreen
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Back as a television delivers it: through the activity's back dispatcher, not as a key event.
 * Bug: the player had no back handler, so the detail underneath took Back and closed itself while
 * the video kept playing.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerBackTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private fun back() {
    compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()
  }

  @Test
  fun `back over the player hides the controls first, then leaves the player and not the detail`() {
    var playerOpen by mutableStateOf(true)
    var detailBacks = 0
    compose.setContent {
      DetailScreen(
        detail = DetailData(gridPath = "Films/It", title = "It", year = null, description = null, poster = null, wide = null, size = 0.0, fileCount = 0, files = emptyList()),
        imageUrl = { null },
        onPlay = {},
        onBack = { detailBacks++ },
        progress = { _: String -> null as ProgressDto? },
        backEnabled = !playerOpen,
      )
      if (playerOpen) {
        PlayerOverlayShell(
          position = 10.0,
          duration = 100.0,
          playing = false,
          title = "It",
          eyebrow = "Direct play",
          playFocus = FocusRequester(),
          initiallyShown = true,
          onSeek = {},
          onTogglePause = {},
          onExit = { playerOpen = false },
        ) { Box(Modifier.fillMaxSize()) }
      }
    }
    compose.waitForIdle()

    back()
    assertEquals(true, playerOpen)
    assertEquals(0, detailBacks)

    back()
    assertEquals(false, playerOpen)
    assertEquals(0, detailBacks)

    back()
    assertEquals(1, detailBacks)
  }
}
