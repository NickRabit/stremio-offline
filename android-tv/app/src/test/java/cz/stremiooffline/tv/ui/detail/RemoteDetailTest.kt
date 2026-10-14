@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.detail

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteItemStateDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.FakeTvApi
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The native remote detail persists its clear through the state endpoint, keeps its flags and
 *  never lets another version wear a position it did not store. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class RemoteDetailTest {

  @get:Rule val compose = createEmptyComposeRule()

  private lateinit var scenario: ActivityScenario<ComponentActivity>

  @Before
  fun launchHost() {
    scenario = ActivityScenario.launch(
      Intent(ApplicationProvider.getApplicationContext(), ComponentActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
  }

  @After
  fun closeHost() {
    scenario.close()
  }

  private fun data() = RemoteDetailData(
    libraryId = "rlibA",
    libraryName = "Filmy",
    provider = "jellyfin",
    item = RemoteItemDto(id = "iA", name = "Heat", type = "movie"),
  )

  private fun version(sourceId: String) = StreamDto(
    sourceId = sourceId,
    kind = "remote",
    playable = true,
    name = "Version $sourceId",
    remoteItem = RemoteItemContext(
      libraryId = "rlibA",
      itemId = "iA",
      mediaSourceId = sourceId,
      progressKey = "remote:rlibA:iA",
    ),
  )

  private val played = mutableListOf<PlayTarget>()

  private fun mount(api: FakeTvApi) {
    scenario.onActivity { activity ->
      activity.setContent {
        RemoteDetailScreen(api = api, data = data(), onPlay = { played += it }, onBack = {})
      }
    }
    compose.waitForIdle()
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  /** RIGHT from Play walks the toolbar; the target holds focus once it is reached. */
  private fun focusByLabel(label: String) {
    repeat(6) {
      val onTarget = compose.onAllNodes(isFocused() and hasContentDescription(label)).fetchSemanticsNodes().isNotEmpty()
      if (onTarget) return
      press(Key.DirectionRight)
    }
    compose.onNodeWithContentDescription(label).assertIsFocused()
  }

  @Test
  fun `forget sends a zeroed patch without touching the favourite or watched flags`() {
    val api = FakeTvApi()
    api.remoteSourcesValue = listOf(version("a1"))
    api.remoteStateValue = RemoteItemStateDto(
      position = 900.0,
      duration = 1800.0,
      favorite = true,
      watched = true,
      mediaSourceId = "a1",
    )
    mount(api)

    focusByLabel("Forget progress")
    press(Key.DirectionCenter)

    val patch = api.remoteStatePatches.single()
    assertEquals(0.0, patch.position ?: -1.0, 0.0)
    assertEquals(0.0, patch.duration ?: -1.0, 0.0)
    assertNull(patch.favorite)
    assertNull(patch.watched)
    assertEquals("a1", api.remoteStateValue.mediaSourceId)
    // The local stored position is gone, so the bar and the control with it.
    compose.onNodeWithTag(TagRemoteDetailWatched).assertDoesNotExist()
    compose.onNodeWithContentDescription("Forget progress").assertDoesNotExist()
  }

  @Test
  fun `a failed forget keeps the stored position and shows the failure`() {
    val api = FakeTvApi()
    api.remoteSourcesValue = listOf(version("a1"))
    api.remoteStateValue = RemoteItemStateDto(position = 900.0, duration = 1800.0, favorite = true, mediaSourceId = "a1")
    api.remoteStatePatchFailure = ApiError(ApiFailure.Generic)
    mount(api)

    focusByLabel("Forget progress")
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagRemoteDetailWatched).assertTextContains("50 % watched")
    compose.onNodeWithText("Your saved position could not be loaded.").assertExists()
  }

  @Test
  fun `a failed forget keeps a Start over that plays without resume`() {
    val api = FakeTvApi()
    api.remoteSourcesValue = listOf(version("a1"))
    api.remoteStateValue = RemoteItemStateDto(position = 900.0, duration = 1800.0, mediaSourceId = "a1")
    api.remoteStatePatchFailure = ApiError(ApiFailure.Generic)
    mount(api)

    focusByLabel("Forget progress")
    press(Key.DirectionCenter)

    compose.onNodeWithContentDescription("Start over").assertExists()
    // Back to the primary action, then one step right onto Start over.
    compose.onNodeWithTag(TagRemoteDetailPlay).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
    press(Key.DirectionRight)
    press(Key.DirectionCenter)

    assertEquals(1, played.size)
    assertEquals(false, played.single().resume)
  }

  @Test
  fun `a stored version that is no longer offered shows no other version's progress`() {
    val api = FakeTvApi()
    api.remoteSourcesValue = listOf(version("a1"))
    api.remoteStateValue = RemoteItemStateDto(position = 900.0, duration = 1800.0, mediaSourceId = "gone")
    mount(api)

    compose.onNodeWithTag(TagRemoteDetailWatched).assertDoesNotExist()
    compose.onNodeWithText("Play").assertExists()
  }
}
