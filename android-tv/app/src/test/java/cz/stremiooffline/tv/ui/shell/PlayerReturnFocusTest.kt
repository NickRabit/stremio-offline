@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.HomeCardsJson
import cz.stremiooffline.tv.data.HomeOrderEntry
import cz.stremiooffline.tv.data.HomeResponseDto
import cz.stremiooffline.tv.data.HomeRowDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.ui.home.homeCardTag
import cz.stremiooffline.tv.ui.detail.TagRemoteDetailPlay
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import cz.stremiooffline.tv.data.CatalogDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.StreamSourceDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.TagCatalogPrimary
import cz.stremiooffline.tv.ui.catalog.posterTag
import cz.stremiooffline.tv.ui.player.TAG_OSD_PLAY
import cz.stremiooffline.tv.ui.player.TAG_OVERLAY_ROOT
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Leaving the player that was opened from a catalogue detail hands the remote back to that detail,
 * not to the catalogue grid hidden underneath it -- on a real TV the detail looked frozen.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerReturnFocusTest {

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

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun back() {
    scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()
  }

  @Test
  fun `leaving the player gives the remote back to the detail, not the grid under it`() {
    val title = MetaDto(id = "tt1", type = "movie", name = "It")
    val api = FakeTvApi().apply {
      settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", streamSort = "recommended")
      catalogsValue = listOf(CatalogDto(addonKey = "a", addonName = "Cinemeta", type = "movie", id = "top", name = "Popular"))
      catalogPages["a"] = listOf(listOf(title))
      streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("s", "Source"))
      addonStreams["movie:tt1|s"] = listOf(StreamDto(sourceId = "src1", kind = "remote", playable = true, title = "1080p", addonName = "Source"))
    }
    scenario.onActivity { activity ->
      activity.setContent { Shell(start = Section.Catalog, api = api, username = "demo", onSignOut = {}) }
    }
    compose.waitForIdle()

    press(Key.DirectionDown)
    compose.onNodeWithTag(posterTag(title)).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { runCatching { compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused() }.isSuccess }

    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { compose.onAllNodes(androidx.compose.ui.test.hasTestTag(TAG_OVERLAY_ROOT)).fetchSemanticsNodes().isNotEmpty() }

    // Back hides the controls, then leaves the player.
    repeat(3) {
      if (compose.onAllNodes(androidx.compose.ui.test.hasTestTag(TAG_OVERLAY_ROOT)).fetchSemanticsNodes().isEmpty()) return@repeat
      back()
    }
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
  }

  @Test
  fun `a player opened from a catalogue detail owns the remote and shows its controls`() {
    val title = MetaDto(id = "tt1", type = "movie", name = "It")
    val api = FakeTvApi().apply {
      settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", streamSort = "recommended")
      catalogsValue = listOf(CatalogDto(addonKey = "a", addonName = "Cinemeta", type = "movie", id = "top", name = "Popular"))
      catalogPages["a"] = listOf(listOf(title))
      streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("s", "Source"))
      addonStreams["movie:tt1|s"] = listOf(StreamDto(sourceId = "src1", kind = "remote", playable = true, title = "1080p", addonName = "Source"))
    }
    scenario.onActivity { activity ->
      activity.setContent { Shell(start = Section.Catalog, api = api, username = "demo", onSignOut = {}) }
    }
    compose.waitForIdle()

    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { runCatching { compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused() }.isSuccess }
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { compose.onAllNodes(androidx.compose.ui.test.hasTestTag(TAG_OVERLAY_ROOT)).fetchSemanticsNodes().isNotEmpty() }

    // The detail underneath must not keep the remote: the player takes it (its root while the
    // controls are hidden, the play button while they are up).
    val playerHasRemote = {
      listOf(TAG_OVERLAY_ROOT, TAG_OSD_PLAY).any { tag ->
        runCatching { compose.onNodeWithTag(tag).assertIsFocused() }.isSuccess
      }
    }
    compose.waitUntil(5_000) { playerHasRemote() }
  }

  @Test
  fun `the screen stays on while a catalogue play is up and is released when it closes`() {
    val title = MetaDto(id = "tt1", type = "movie", name = "It")
    val api = FakeTvApi().apply {
      settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", streamSort = "recommended")
      catalogsValue = listOf(CatalogDto(addonKey = "a", addonName = "Cinemeta", type = "movie", id = "top", name = "Popular"))
      catalogPages["a"] = listOf(listOf(title))
      streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("s", "Source"))
      addonStreams["movie:tt1|s"] = listOf(StreamDto(sourceId = "src1", kind = "remote", playable = true, title = "1080p", addonName = "Source"))
    }
    scenario.onActivity { activity ->
      activity.setContent { Shell(start = Section.Catalog, api = api, username = "demo", onSignOut = {}) }
    }
    compose.waitForIdle()
    val keepOn = {
      var value = false
      scenario.onActivity { activity ->
        // The flag sits on the composition's own view, a few levels under the content frame.
        fun anyKeepsScreenOn(view: android.view.View): Boolean =
          view.keepScreenOn || (view is android.view.ViewGroup && (0 until view.childCount).any { anyKeepsScreenOn(view.getChildAt(it)) })
        value = anyKeepsScreenOn(activity.findViewById(android.R.id.content))
      }
      value
    }
    org.junit.Assert.assertFalse(keepOn())

    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { runCatching { compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused() }.isSuccess }
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { compose.onAllNodes(androidx.compose.ui.test.hasTestTag(TAG_OVERLAY_ROOT)).fetchSemanticsNodes().isNotEmpty() }
    compose.waitUntil(5_000) { keepOn() }

    repeat(3) {
      if (compose.onAllNodes(androidx.compose.ui.test.hasTestTag(TAG_OVERLAY_ROOT)).fetchSemanticsNodes().isEmpty()) return@repeat
      back()
    }
    compose.waitForIdle()
    org.junit.Assert.assertFalse(keepOn())
  }

  @Test
  fun `Home refresh waits until a remote detail closes after its player returns`() {
    val card = HomeCard.Remote(key = "remote:one", title = "Movie", provider = "jellyfin",
      libraryId = "rlibA", libraryName = "Movies", itemId = "iA")
    val encoded = HomeCardsJson.encodeToJsonElement(HomeCard.serializer(), card) as JsonObject
    val api = FakeTvApi().apply {
      homeHandler = { asked ->
        HomeResponseDto(order = listOf(HomeOrderEntry("resume")),
          rows = if (asked.isEmpty()) emptyMap() else mapOf("resume" to HomeRowDto(items = listOf(encoded))))
      }
      remoteSourcesValue = listOf(StreamDto(sourceId = "remote1", kind = "remote", playable = true,
        remoteItem = RemoteItemContext(libraryId = "rlibA", itemId = "iA", mediaSourceId = "v1", progressKey = "remote:one")))
    }
    scenario.onActivity { activity ->
      activity.setContent { Shell(start = Section.Home, api = api, username = "demo", onSignOut = {}) }
    }
    compose.waitForIdle()
    compose.onNodeWithTag(homeCardTag(card.key)).assertIsFocused()
    press(Key.DirectionCenter)
    val playerHasRemote = {
      listOf(TAG_OVERLAY_ROOT, TAG_OSD_PLAY).any { tag ->
        runCatching { compose.onNodeWithTag(tag).assertIsFocused() }.isSuccess
      }
    }
    compose.waitUntil(5_000) { playerHasRemote() }
    val homeRequests = api.homeRequests.size
    compose.waitUntil(5_000) { compose.onAllNodes(androidx.compose.ui.test.hasTestTag(TAG_OVERLAY_ROOT)).fetchSemanticsNodes().isNotEmpty() }
    repeat(3) {
      if (compose.onAllNodes(androidx.compose.ui.test.hasTestTag(TAG_OVERLAY_ROOT)).fetchSemanticsNodes().isNotEmpty()) back()
    }
    compose.waitForIdle()
    compose.onNodeWithTag(TagRemoteDetailPlay).assertIsFocused()
    assertEquals(homeRequests, api.homeRequests.size)
    back()
    compose.onNodeWithTag(homeCardTag(card.key)).assertIsFocused()
    assertTrue(api.homeRequests.size > homeRequests)
  }

}
