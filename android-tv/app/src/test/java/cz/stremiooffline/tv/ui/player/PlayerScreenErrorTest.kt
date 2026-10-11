@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.ClientCapabilitiesDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The error state before the server has answered: no path may be named, and the error panel owns
 * the layer above the OSD. Bug on the emulator: the eyebrow claimed direct play and the OSD was
 * drawn over the panel, so OK never reached Try again.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerScreenErrorTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private val directPath = "Direct play · no server conversion"
  private var exited = false

  @Test
  fun `a start that has not answered names no path`() {
    val api = GatedApi()
    mount(api)
    // The request is in flight, so the server has not chosen a mode yet.
    assertEquals(0, compose.onAllNodesWithText(directPath).fetchSemanticsNodes().size)

    api.gate.completeExceptionally(ApiError(ApiFailure.Unreachable))
    compose.waitForIdle()
    assertEquals(0, compose.onAllNodesWithText(directPath).fetchSemanticsNodes().size)
  }

  @Test
  fun `the error panel is drawn above the OSD`() {
    val api = GatedApi()
    mount(api)
    api.gate.completeExceptionally(ApiError(ApiFailure.Unreachable))
    compose.waitForIdle()

    assertEquals(listOf(TAG_OSD_PLAY, TAG_ERROR_PANEL), drawnOrder())
  }

  @Test
  fun `Back over the error panel leaves the player`() {
    val api = GatedApi()
    mount(api)
    api.gate.completeExceptionally(ApiError(ApiFailure.Unreachable))
    compose.waitForIdle()
    compose.onNodeWithTag(TAG_ERROR_PANEL).assertExists()

    compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()

    assertEquals(true, exited)
  }

  // The emulator hands Back to the window first; the panel above the OSD has to take it there too.
  @Test
  fun `a real back key over the error panel leaves the player`() {
    val api = GatedApi()
    mount(api)
    api.gate.completeExceptionally(ApiError(ApiFailure.Unreachable))
    compose.waitForIdle()
    compose.onNodeWithTag(TAG_ERROR_PANEL).assertExists()

    compose.runOnUiThread {
      compose.activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK))
      compose.activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_BACK))
    }
    compose.waitForIdle()

    assertEquals(true, exited)
  }

  private fun mount(api: FakeTvApi) {
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(key = "movie:tt1", title = "It", resume = false, sourceId = "src1"),
        onExit = { exited = true },
      )
    }
    compose.waitForIdle()
  }

  /** The tagged nodes in the order the tree draws them: later means on top. */
  private fun drawnOrder(): List<String> =
    compose.onAllNodes(hasTestTag(TAG_ERROR_PANEL) or hasTestTag(TAG_OSD_PLAY)).fetchSemanticsNodes()
      .mapNotNull { it.config.getOrNull(SemanticsProperties.TestTag) }

  private class GatedApi : FakeTvApi() {
    val gate = CompletableDeferred<Unit>()

    override suspend fun startPlayback(
      sourceId: String,
      capabilities: ClientCapabilitiesDto,
      time: Double,
      subtitleIds: List<String>,
    ): PlaybackDescriptorDto {
      gate.await()
      throw ApiError(ApiFailure.Unreachable)
    }
  }
}
