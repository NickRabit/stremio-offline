@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.SidecarFetch
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Bug on the emulator: Obsession resumed at 78 started a transcode whose descriptor already named
 * `subtitleTrack` 2 and a `sidecarUrl`, the reader had reached the player, and no cue was ever
 * drawn. The server rebases the sidecar to the stream the conversion starts at (its first cue
 * arrived as 79.627 - 78 = 1.627 s) while the player's position is absolute, so the cues have to
 * be shifted back before they are matched.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerScreenSidecarTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private val key = "series:tt1:1:1"
  private val sidecar = "/api/playback/p1/sidecar.vtt?revision=r1&offset=78.000"

  private val api = FakeTvApi().apply {
    progressValues[key] = ProgressDto(position = 80.0, duration = 3_000.0)
    startAnswer = PlaybackDescriptorDto(
      id = "p1",
      mode = "transcode",
      url = "/transcode.m3u8",
      playlist = true,
      offset = 78.0,
      duration = 3_000.0,
      audioTracks = tracks("""{"index":0,"language":"en","codec":"aac","channels":2}"""),
      audioTrack = 0,
      subtitleTracks = tracks(
        """{"index":0,"language":"en","codec":"subrip"}""",
        """{"index":1,"language":"en","codec":"mov_text"}""",
        """{"index":2,"language":"cs","codec":"subrip"}""",
      ),
      subtitleTrack = 2,
      sidecarUrl = sidecar,
    )
    // The reader reached the picture: the file's first cue is at 79.627 s, sent rebased.
    sidecarValue = SidecarFetch(
      text = "WEBVTT\n\n00:01.627 --> 00:05.263\nDrawn to her, is he?",
      complete = true,
      coverage = Double.POSITIVE_INFINITY,
    )
  }

  private fun mount() {
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(key = key, title = "Obsession", resume = true, sourceId = "src1"),
        onExit = {},
      )
    }
    compose.waitForIdle()
  }

  @Test
  fun `a cue from the start descriptor's sidecar is drawn at the resumed position`() {
    mount()

    assertEquals(sidecar, api.sidecarRequests.firstOrNull()?.first)
    // The picture only reaches the resumed position on the player's quarter-second tick.
    compose.waitUntil(5_000) { compose.onAllNodesWithTag(TagSubtitleOverlay).fetchSemanticsNodes().isNotEmpty() }
    compose.onNodeWithTag(TagSubtitleOverlay).assertTextEquals("Drawn to her, is he?")
  }

  private fun tracks(vararg items: String): List<JsonObject> =
    items.map { Json.parseToJsonElement(it).jsonObject }
}
