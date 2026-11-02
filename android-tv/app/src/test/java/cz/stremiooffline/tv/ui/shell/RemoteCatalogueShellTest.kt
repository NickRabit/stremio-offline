@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.RemoteItemDetailDto
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteItemsPageDto
import cz.stremiooffline.tv.data.RemoteLibraryDto
import cz.stremiooffline.tv.data.RemotePersonalPage
import cz.stremiooffline.tv.data.RemoteProviderIdsDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.TitleRefDto
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.TagCatalogEpisode
import cz.stremiooffline.tv.ui.catalog.TagCatalogPrimary
import cz.stremiooffline.tv.ui.detail.TagRemoteDetailPlay
import cz.stremiooffline.tv.ui.library.remoteItemTag
import cz.stremiooffline.tv.ui.library.remoteLibraryTag
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class RemoteCatalogueShellTest {

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

  private fun mount(api: FakeTvApi) {
    scenario.onActivity { activity ->
      activity.setContent { Shell(start = Section.Library, api = api, username = "demo", onSignOut = {}) }
    }
    compose.waitForIdle()
  }

  private fun openItem(itemId: String) {
    compose.onNodeWithText("Media servers").performSemanticsAction(SemanticsActions.RequestFocus)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { runCatching { compose.onNodeWithTag(remoteLibraryTag("library")).assertIsFocused() }.isSuccess }
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { runCatching { compose.onNodeWithTag(remoteItemTag(itemId)).assertIsFocused() }.isSuccess }
    press(Key.DirectionCenter)
  }

  private fun api(item: RemoteItemDto) = FakeTvApi().apply {
    settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en")
    remoteLibrariesValue = listOf(RemoteLibraryDto(id = "library", name = "Library", provider = "jellyfin", type = "series"))
    remoteItemsPages["library|"] = RemoteItemsPageDto(items = listOf(item), total = 1)
    remoteItemValues["library:${item.id}"] = RemoteItemDetailDto(item = item)
  }

  @Test
  fun `a resumed series opens its catalogue episode and Back restores the server grid item`() {
    val item = RemoteItemDto(id = "show", name = "2 Broke Girls", type = "series")
    val api = api(item).apply {
      remoteItemValues["library:show"] = RemoteItemDetailDto(
        item.copy(providerIds = RemoteProviderIdsDto(imdb = "tt100")),
      )
      remotePersonalValue = RemotePersonalPage(
        items = listOf(
          HomeCard.Remote(
            key = "episode-two",
            libraryId = "library",
            itemId = "episode-two",
            itemType = "episode",
            mediaSourceId = "source-two",
            season = 1,
            episode = 2,
            identity = TitleRefDto(type = "series", id = "tt100"),
          ),
        ),
        total = 1,
        partial = false,
      )
      metaValues["series:tt100"] = MetaDto(
        id = "tt100",
        type = "series",
        name = "2 Broke Girls",
        videos = listOf(VideoDto(id = "tt100:1:2", title = "And the One-Liner", season = 1, episode = 2)),
      )
    }
    mount(api)

    openItem("show")

    compose.waitUntil(5_000) { runCatching { compose.onNodeWithTag(TagCatalogPrimary).assertExists() }.isSuccess }
    compose.onNodeWithTag(TagCatalogEpisode).assertTextContains("S1 · E2 · And the One-Liner")
    assertTrue(api.remotePersonalRequests.contains(Triple("resume", 0, 60)))

    scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    compose.waitUntil(5_000) { runCatching { compose.onNodeWithTag(remoteItemTag("show")).assertIsFocused() }.isSuccess }
  }

  @Test
  fun `an item without provider ids keeps the remote detail screen`() {
    val item = RemoteItemDto(id = "movie", name = "Movie", type = "movie")
    mount(api(item))

    openItem("movie")

    compose.waitUntil(5_000) { runCatching { compose.onNodeWithTag(TagRemoteDetailPlay).assertExists() }.isSuccess }
    compose.onNodeWithTag(TagCatalogPrimary).assertDoesNotExist()
  }
}
