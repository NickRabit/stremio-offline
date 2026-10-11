@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A switch that is still reading the account when the viewer leaves must never start a session: the
 * controller is released, so the late answer is dropped instead of converting for nobody.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerScreenCloseTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private val alpha = StreamDto(sourceId = "srcA", kind = "remote", playable = true, name = "small", title = "Czech 1 GB", addonName = "Alpha")
  private val beta = StreamDto(sourceId = "srcB", kind = "remote", playable = true, name = "big", title = "Czech 8 GB", addonName = "Beta")

  @Test
  fun `a switch that answers after the player closed starts nothing`() {
    val api = GatedSettingsApi()
    var exited = false
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(key = "movie:tt1", title = "It", resume = false, sourceId = "srcA"),
        onExit = { exited = true },
        sources = listOf(alpha, beta),
      )
    }
    compose.waitForIdle()
    compose.waitUntil(5_000) { compose.onAllNodesWithTag(TAG_OSD_SOURCES).fetchSemanticsNodes().isNotEmpty() }
    assertEquals(listOf("srcA"), api.startedSources)

    // Open the panel on srcA, move to srcB and pick it; the switch parks on the gated settings read.
    repeat(3) { press(KeyEvent.KEYCODE_DPAD_RIGHT) }
    compose.onNodeWithTag(TAG_OSD_SOURCES).assertIsFocused()
    press(KeyEvent.KEYCODE_DPAD_CENTER)
    press(KeyEvent.KEYCODE_DPAD_DOWN)
    press(KeyEvent.KEYCODE_DPAD_CENTER)
    compose.waitForIdle()
    assertEquals(listOf("srcA"), api.startedSources)

    back()
    back()
    assertTrue("the second back leaves the player", exited)

    api.gate.complete(Unit)
    compose.waitForIdle()

    assertEquals("no session may start after the player closed", listOf("srcA"), api.startedSources)
    assertTrue("no ping may follow the player out", api.pings.isEmpty())
  }

  /** A real remote key: it travels through the window instead of straight into Compose. */
  private fun press(keyCode: Int) {
    compose.runOnUiThread {
      compose.activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, keyCode))
      compose.activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, keyCode))
    }
    compose.waitForIdle()
  }

  private fun back() {
    compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()
  }

  /** The first account read answers; the switch's read parks until the test releases it. */
  private class GatedSettingsApi : FakeTvApi() {
    val gate = CompletableDeferred<Unit>()
    val pings = mutableListOf<String>()

    override suspend fun settings(): SettingsResponse {
      val answer = super.settings()
      if (settingsCalls >= 2) gate.await()
      return answer
    }

    override suspend fun pingPlayback(id: String) {
      pings += id
    }
  }
}
