package cz.stremiooffline.tv.ui.player

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import cz.stremiooffline.tv.playback.DiagPath
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerDiagnosticsPanelTest {

  @get:Rule val compose = createComposeRule()

  @Test
  fun `a value the player could not read is the dash, never a guess`() {
    compose.setContent {
      PlayerDiagnosticsPanel(
        path = DiagPath.Direct,
        container = null,
        video = null,
        hdr = null,
        audio = null,
        subtitles = null,
        bitrate = null,
        buffer = null,
        session = null,
        device = null,
        converted = false,
        onClose = {},
      )
    }

    // Container, video, HDR, audio, subtitles, bitrate, buffer, session and device.
    assertEquals(9, compose.onAllNodesWithText(DIAGNOSTIC_UNKNOWN).fetchSemanticsNodes().size)
  }

  @Test
  fun `a converting session says the values describe the server output`() {
    compose.setContent {
      PlayerDiagnosticsPanel(
        path = DiagPath.Transcode,
        container = null,
        video = "video/avc · 1280×720",
        hdr = null,
        audio = null,
        subtitles = "in the file",
        bitrate = "4.0 Mb/s",
        buffer = "30 s",
        session = "12 s ago",
        device = "NVIDIA Shield TV Pro · Android 11",
        converted = true,
        onClose = {},
      )
    }

    compose.onNodeWithText("The server is converting: these values describe its output, not the file.").assertExists()
    compose.onNodeWithText("video/avc · 1280×720").assertExists()
  }
}
