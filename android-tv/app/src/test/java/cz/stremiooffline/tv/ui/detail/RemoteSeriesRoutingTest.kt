@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.detail

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.RemoteItemDetailDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteItemsPageDto
import cz.stremiooffline.tv.data.RemoteItemStateDto
import cz.stremiooffline.tv.data.RemoteProviderIdsDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.library.remoteItemTag
import cz.stremiooffline.tv.ui.library.TagRemoteSeriesRoot
import kotlinx.coroutines.CompletableDeferred
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

  private val played = mutableListOf<PlayTarget>()

  private fun series(ids: RemoteProviderIdsDto = RemoteProviderIdsDto()) = RemoteDetailData(
    libraryId = "rlibA",
    libraryName = "Filmy",
    provider = "jellyfin",
    item = RemoteItemDto(id = "s1", name = "Show", type = "series", providerIds = ids),
  )

  private fun episode(id: String) = RemoteItemDto(id = id, name = "Pilot", type = "episode", season = 1, episode = 1)
  private fun series(id: String, name: String) = RemoteDetailData(
    libraryId = "rlibA",
    libraryName = "Filmy",
    provider = "jellyfin",
    item = RemoteItemDto(id = id, name = name, type = "series"),
  )

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
  fun `an episode of a named show resumes the show's own row`() {
    val api = FakeTvApi()
    api.remoteEpisodesPages["s1|"] = RemoteItemsPageDto(items = listOf(episode("e1")), total = 1)
    api.remoteSourcesValue = listOf(version())
    // The episode's own item stores nothing; the show's own row holds the position the catalogue
    // and the player write, so the episode's detail has to read the same one.
    api.remoteStateValue = RemoteItemStateDto()
    api.progressValues["series:tt7:1:1"] = ProgressDto(position = 900.0, duration = 3600.0)
    scenario.onActivity { activity ->
      activity.setContent {
        RemoteDetailScreen(
          api = api,
          data = series(RemoteProviderIdsDto(imdb = "tt7")),
          onPlay = { played += it },
          onBack = {},
          titleProgress = api::progress,
        )
      }
    }
    compose.waitUntil(5_000) { api.remoteEpisodesRequests.isNotEmpty() }
    compose.waitForIdle()
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.remoteSourcesRequests.contains("rlibA" to "e1") }
    compose.waitForIdle()

    compose.onNodeWithTag(TagRemoteDetailPlay).assertTextContains("Resume")
    press(Key.DirectionCenter)

    assertEquals(listOf("series:tt7:1:1"), played.map { it.key })
    assertTrue(played.single().resume)
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
    compose.onNodeWithTag(TagRemoteSeriesRoot).assertExists()
    compose.onNodeWithTag(remoteItemTag("e1")).assertIsFocused()
    val still = compose.onNodeWithTag(remoteItemTag("e1")).getBoundsInRoot()
    assertTrue("episode still is ${still.right - still.left}x${still.bottom - still.top}", still.right - still.left > still.bottom - still.top)

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

  @Test
  fun `quick A then B never shows A's late episodes under B`() {
    val api = FakeTvApi()
    val current = mutableStateOf(series("s1", "Show A"))
    val aGate = CompletableDeferred<Unit>()
    api.remoteBrowseGates["s1"] = aGate
    api.remoteEpisodesPages["s1|"] = RemoteItemsPageDto(
      items = listOf(episode("a1").copy(name = "A episode", season = 1, episode = 1)),
      total = 1,
    )
    api.remoteEpisodesPages["s2|"] = RemoteItemsPageDto(
      items = listOf(episode("b1").copy(name = "B episode", season = 7, episode = 1)),
      total = 1,
    )
    scenario.onActivity { activity ->
      activity.setContent {
        RemoteDetailScreen(api = api, data = current.value, onPlay = {}, onBack = {})
      }
    }
    compose.waitUntil(5_000) { api.remoteBrowseRequests.any { it.parentId == "s1" } }

    compose.runOnIdle { current.value = series("s2", "Show B") }
    compose.waitUntil(5_000) {
      compose.onAllNodes(androidx.compose.ui.test.hasTestTag(remoteItemTag("b1"))).fetchSemanticsNodes().isNotEmpty()
    }
    aGate.complete(Unit)
    compose.waitForIdle()

    compose.onNodeWithText("Show B").assertExists()
    compose.onNodeWithTag(remoteItemTag("b1")).assertExists()
    compose.onNodeWithTag(remoteItemTag("a1")).assertDoesNotExist()
    compose.onNodeWithText("S7 · E1").assertExists()
  }
  private fun assertEarlyPlayKeepsIdentity(autoPlay: Boolean) {
    val api = FakeTvApi()
    val gate = CompletableDeferred<Unit>()
    api.remoteItemGates["rlibA:s1"] = gate
    api.remoteItemValues["rlibA:s1"] = RemoteItemDetailDto(
      RemoteItemDto(id = "s1", type = "series", name = "Exact show", providerIds = RemoteProviderIdsDto(imdb = "tt1234567")),
    )
    api.remoteSourcesValue = listOf(version())
    val data = RemoteDetailData(
      libraryId = "rlibA", libraryName = "Shows", provider = "jellyfin",
      item = episode("e1").copy(seriesId = "s1"), autoPlay = autoPlay,
    )
    scenario.onActivity { activity ->
      activity.setContent {
        RemoteDetailScreen(api = api, data = data, onPlay = { played += it }, onBack = {}, catalogueApi = api)
      }
    }
    compose.waitUntil(5_000) { api.remoteItemRequests.contains("rlibA" to "s1") && api.remoteSourcesRequests.isNotEmpty() }
    compose.waitForIdle()
    if (!autoPlay) {
      compose.onNodeWithTag(TagRemoteDetailPlay).assertIsFocused()
      press(Key.DirectionCenter)
    }
    compose.waitForIdle()
    assertTrue(played.isEmpty())
    gate.complete(Unit)
    compose.waitUntil(5_000) { played.size == 1 }
    assertEquals("series", played.single().subtitleType)
    assertEquals("tt1234567:1:1", played.single().subtitleTarget)
    assertEquals("series:tt1234567:1:1", played.single().key)
    assertEquals("Exact show", played.single().subtitleName)
  }

  @Test
  fun `a quick Play waits for exact metadata before building the target`() = assertEarlyPlayKeepsIdentity(false)

  @Test
  fun `autoPlay waits for exact metadata before building the target`() = assertEarlyPlayKeepsIdentity(true)

}
