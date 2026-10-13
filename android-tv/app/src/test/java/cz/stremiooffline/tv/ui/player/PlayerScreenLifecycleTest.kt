@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import android.content.Intent
import android.os.PowerManager
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.Lifecycle
import cz.stremiooffline.tv.data.ClientCapabilitiesDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Leaving (Home) and the screen turning off release the session, and coming back starts a fresh
 * one. A screensaver stops the activity without either of those, and must keep the session: the
 * remote otherwise waited on a new open after the screensaver was dismissed.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerScreenLifecycleTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  @After fun resetBackground() {
    PlayerLeave.requested = false
    PlayerDream.active = false
  }

  @Test
  fun `leaving the app and coming back starts a fresh session`() {
    val api = mount()
    assertEquals(1, api.started.size)

    PlayerLeave.requested = true
    compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
    compose.waitForIdle()
    assertEquals(listOf("p1"), api.deleted)

    compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
    compose.waitForIdle()

    assertEquals(2, api.started.size)
    assertEquals(0.0, api.started.last().third, 0.001)
  }

  @Test
  fun `the screensaver keeps the session and coming back does not open another`() {
    val api = mount()

    compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
    compose.waitForIdle()
    assertTrue(api.deleted.isEmpty())

    compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
    compose.waitForIdle()
    assertEquals(1, api.started.size)
    assertTrue(api.deleted.isEmpty())
  }

  @Test
  fun `a dream keeps the session when the stop is also reported as a leave`() {
    val api = mount()
    PlayerDream.active = true
    PlayerLeave.requested = true

    compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
    compose.waitForIdle()
    assertTrue(api.deleted.isEmpty())
    assertEquals(1, api.started.size)
  }

  @Test
  fun `the screen turning off releases the session`() {
    val api = mount()
    val power = compose.activity.getSystemService(PowerManager::class.java)
    shadowOf(power).setIsInteractive(false)

    compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
    compose.waitForIdle()
    assertEquals(listOf("p1"), api.deleted)
  }

  @Test
  fun `standby after a screensaver releases the session that was kept`() {
    val api = mount()
    compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
    compose.waitForIdle()
    assertTrue(api.deleted.isEmpty())

    compose.activity.sendBroadcast(Intent(Intent.ACTION_SCREEN_OFF))
    compose.waitForIdle()
    assertEquals(listOf("p1"), api.deleted)
  }

  private fun mount(): RecordingApi {
    val api = RecordingApi()
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(key = "movie:tt1", title = "It", resume = false, sourceId = "src1"),
        onExit = {},
      )
    }
    compose.waitForIdle()
    return api
  }

  private class RecordingApi : FakeTvApi() {
    val started = mutableListOf<Triple<String, ClientCapabilitiesDto, Double>>()
    val deleted = mutableListOf<String>()

    override suspend fun startPlayback(
      sourceId: String,
      capabilities: ClientCapabilitiesDto,
      time: Double,
      subtitleIds: List<String>,
    ): PlaybackDescriptorDto {
      started += Triple(sourceId, capabilities, time)
      return PlaybackDescriptorDto(id = "p1", url = "/stream.mp4")
    }

    override suspend fun deletePlayback(id: String) {
      deleted += id
    }
  }
}
