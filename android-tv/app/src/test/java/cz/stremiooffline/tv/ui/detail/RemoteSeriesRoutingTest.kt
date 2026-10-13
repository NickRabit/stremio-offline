@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.detail

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteItemsPageDto
import cz.stremiooffline.tv.data.RemoteItemStateDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.library.remoteItemTag
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A remote series card opens its episodes, not the playable-item detail the server refuses. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class RemoteSeriesRoutingTest {

  @get:Rule val compose = createEmptyComposeRule()

  private lateinit var scenario: ActivityScenario<ComponentActivity>
  private var host: ComponentActivity? = null

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

  private fun series() = RemoteDetailData(
    libraryId = "rlibA",
    libraryName = "Filmy",
    provider = "jellyfin",
    item = RemoteItemDto(id = "s1", name = "Show", type = "series"),
  )

  private fun episode(id: String) = RemoteItemDto(id = id, name = "Pilot", type = "episode", season = 1, episode = 1)

  private fun version() = StreamDto(
    sourceId = "ms1",
    kind = "remote",
    playable = true,
    name = "FullHD",
    remoteItem = RemoteItemContext(libraryId = "rlibA", itemId = "e1", mediaSourceId = "ms1", progressKey = "remote:rlibA:e1"),
  )

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  @Test
  fun `a series card opens its episodes and Back returns to the grid before closing`() {
    val api = FakeTvApi()
    api.remoteEpisodesPages["s1|"] = RemoteItemsPageDto(items = listOf(episode("e1"), episode("e2")), total = 2)
    api.remoteSourcesValue = listOf(version())
    var backs = 0
    val restoreToken = mutableIntStateOf(0)
    scenario.onActivity { activity ->
      host = activity
      activity.setContent {
        RemoteDetailScreen(
          api = api,
          data = series(),
          onPlay = {},
          onBack = { backs++ },
          restoreToken = restoreToken.intValue,
        )
      }
    }
    compose.waitUntil(5_000) { api.remoteEpisodesRequests.isNotEmpty() }
    compose.waitForIdle()

    // The series itself never asks for versions: its episodes are the whole detail.
    assertTrue(api.remoteSourcesRequests.isEmpty())
    compose.onNodeWithTag(remoteItemTag("e1")).assertIsFocused()

    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.remoteSourcesRequests.contains("rlibA" to "e1") }
    compose.waitForIdle()
    compose.onNodeWithTag(TagRemoteDetailPlay).assertExists()
    compose.onNodeWithTag(remoteItemTag("e1")).assertDoesNotExist()

    api.remoteStateValue = RemoteItemStateDto(favorite = true)
    compose.runOnIdle { restoreToken.intValue++ }
    compose.waitForIdle()
    compose.waitUntil(5_000) { api.remoteSourcesRequests.count { it == "rlibA" to "e1" } == 2 }
    compose.onNodeWithTag(TagRemoteDetailFavorite).assertContentDescriptionEquals("Remove from favorites")

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()

    // The episode's Back closed only the episode; the series grid is up with its card focused.
    assertEquals(0, backs)
    compose.onNodeWithTag(TagRemoteDetailPlay).assertDoesNotExist()
    compose.onNodeWithTag(remoteItemTag("e1")).assertIsFocused()

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()

    assertEquals(1, backs)
  }
}
