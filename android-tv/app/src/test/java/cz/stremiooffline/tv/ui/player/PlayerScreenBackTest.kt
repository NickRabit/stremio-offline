@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import androidx.activity.ComponentActivity
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Every way out of the player releases the session: Back from the panel, Back over the hidden OSD
 * and Back leaving the player. Bug on the emulator: the session outlived the player.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerScreenBackTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private val api = RecordingApi().apply {
    startAnswer = PlaybackDescriptorDto(
      id = "p1",
      url = "/stream.mp4",
      audioTracks = tracks("""{"index":0,"language":"en","codec":"aac","channels":2}"""),
    )
  }

  private var exited = false

  private fun mount() {
    compose.setContent {
      // The screen must release the session itself: a caller that keeps it mounted (the shell
      // replaces it, but the contract cannot depend on that) still gets the DELETE.
      PlayerScreen(
        api = api,
        target = PlayTarget(key = "movie:tt1", title = "It", resume = false, sourceId = "src1"),
        onExit = { exited = true },
      )
    }
    compose.waitForIdle()
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun back() {
    compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()
  }

  @Test
  fun `back through the panel, the osd and the player releases the session once`() {
    mount()
    assertEquals(1, api.startedSubtitleIds.size)

    press(Key.DirectionRight)
    press(Key.DirectionRight)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagTracksPanel).assertExists()

    back()
    compose.onNodeWithTag(TagTracksPanel).assertDoesNotExist()
    assertFalse(exited)

    back()
    assertFalse(exited)

    back()
    assertEquals(true, exited)
    compose.waitUntil(timeoutMillis = 5_000) { api.deleted.isNotEmpty() }
    assertEquals(listOf("p1"), api.deleted)
  }

  private fun tracks(vararg items: String): List<JsonObject> =
    items.map { Json.parseToJsonElement(it).jsonObject }

  private class RecordingApi : FakeTvApi() {
    val deleted = mutableListOf<String>()

    override suspend fun deletePlayback(id: String) {
      deleted += id
    }
  }
}
