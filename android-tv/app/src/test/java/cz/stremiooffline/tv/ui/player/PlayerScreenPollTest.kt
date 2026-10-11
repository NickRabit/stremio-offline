@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.Lifecycle
import cz.stremiooffline.tv.data.AddonSubtitleDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.SidecarFetch
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Subtitle polling belongs to the on-screen session. Leaving the app releases the session, so a
 * poller that keeps asking a deleted one wastes the server and the battery until the viewer returns.
 * Bug on the emulator: the effects outlived ON_STOP and kept asking for the sidecar.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerScreenPollTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private fun mount(api: FakeTvApi, target: PlayTarget) {
    compose.setContent {
      PlayerScreen(api = api, target = target, onExit = {})
    }
    compose.waitForIdle()
  }

  @Test
  fun `the sidecar poll stops while the app is stopped and resumes with the new session`() {
    val api = FakeTvApi().apply {
      startAnswer = PlaybackDescriptorDto(
        id = "p1", mode = "transcode", url = "/transcode.m3u8", playlist = true, offset = 0.0, duration = 3_000.0,
        audioTracks = tracks("""{"index":0,"language":"en","codec":"aac","channels":2}"""),
        audioTrack = 0,
        subtitleTracks = tracks("""{"index":0,"language":"en","codec":"subrip"}"""),
        subtitleTrack = 0,
        sidecarUrl = "/api/playback/p1/sidecar.vtt?revision=r1&offset=0.000",
      )
      sidecarValue = SidecarFetch(text = "WEBVTT\n\n00:00.000 --> 00:10.000\nHello", complete = false, coverage = 1.0)
    }
    mount(api, PlayTarget(key = "series:tt1:1:1", title = "It", resume = false, sourceId = "src1"))

    compose.waitUntil(5_000) { api.sidecarRequests.size >= 3 }
    compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
    compose.waitForIdle()
    val stopped = api.sidecarRequests.size
    compose.mainClock.advanceTimeBy(2_000)
    compose.waitForIdle()
    assertEquals("No poll may be sent for a session the server has already released", stopped, api.sidecarRequests.size)

    compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
    compose.waitUntil(5_000) { api.sidecarRequests.size > stopped }
  }

  @Test
  fun `an addon subtitle is read again when the app comes back with the new session`() {
    val api = FakeTvApi().apply {
      startAnswer = PlaybackDescriptorDto(id = "p1", url = "/stream.mp4", duration = 3_000.0)
      settingsValue = SettingsResponse(subtitleLanguage = "cs")
      subtitlesValue = listOf(AddonSubtitleDto(subtitleId = "sid", lang = "cs", addonName = "OpenSubtitles"))
      subtitleTextValue = "WEBVTT\n\n00:00.000 --> 00:10.000\nHello"
    }
    mount(
      api,
      PlayTarget(
        key = "movie:tt1", title = "It", resume = false, sourceId = "src1",
        subtitleType = "movie", subtitleTarget = "tt1",
      ),
    )
    compose.waitUntil(5_000) { api.subtitleTextRequests.isNotEmpty() }
    assertEquals("sid", api.subtitleTextRequests.first().first)
    val stopped = api.subtitleTextRequests.size

    compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
    compose.waitForIdle()
    compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
    compose.waitUntil(5_000) { api.subtitleTextRequests.size > stopped }
    assertTrue(api.subtitleTextRequests.all { it.first == "sid" })
  }

  private fun tracks(vararg items: String): List<JsonObject> =
    items.map { Json.parseToJsonElement(it).jsonObject }
}
