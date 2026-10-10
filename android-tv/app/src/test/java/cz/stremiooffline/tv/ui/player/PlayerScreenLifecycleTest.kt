@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.Lifecycle
import cz.stremiooffline.tv.data.ClientCapabilitiesDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The background lifecycle: ON_STOP saves and releases the session, and ON_START starts a fresh
 * one. Without the second half the screen came back to a session the server had already deleted.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerScreenLifecycleTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  @Test
  fun `leaving the app and coming back starts a fresh session`() {
    val api = RecordingApi()
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(key = "movie:tt1", title = "It", resume = false, sourceId = "src1"),
        onExit = {},
      )
    }
    compose.waitForIdle()
    assertEquals(1, api.started.size)

    compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
    compose.waitForIdle()
    assertEquals(listOf("p1"), api.deleted)

    compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
    compose.waitForIdle()

    assertEquals(2, api.started.size)
    assertEquals(0.0, api.started.last().third, 0.001)
  }

  private class RecordingApi : FakeTvApi() {
    val started = mutableListOf<Triple<String, ClientCapabilitiesDto, Double>>()
    val deleted = mutableListOf<String>()

    override suspend fun startPlayback(
      sourceId: String,
      capabilities: ClientCapabilitiesDto,
      time: Double,
    ): PlaybackDescriptorDto {
      started += Triple(sourceId, capabilities, time)
      return PlaybackDescriptorDto(id = "p1", url = "/stream.mp4")
    }

    override suspend fun deletePlayback(id: String) {
      deleted += id
    }
  }
}
