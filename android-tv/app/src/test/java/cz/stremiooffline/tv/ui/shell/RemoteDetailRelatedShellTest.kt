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
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.BehaviorHintsDto
import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.HomeCardsJson
import cz.stremiooffline.tv.data.HomeOrderEntry
import cz.stremiooffline.tv.data.HomeResponseDto
import cz.stremiooffline.tv.data.HomeRowDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.RelatedTitleDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteItemDetailDto
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteLibraryDto
import cz.stremiooffline.tv.data.RemoteProviderIdsDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.StreamSourceDto
import cz.stremiooffline.tv.data.TitleExtrasDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.TagCatalogChosenSource
import cz.stremiooffline.tv.ui.catalog.TagCatalogPrimary
import cz.stremiooffline.tv.ui.detail.TagRemoteDetailPlay
import cz.stremiooffline.tv.ui.detail.relatedTitleTag
import cz.stremiooffline.tv.ui.home.homeCardTag
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A similar title opened from a Jellyfin/Emby detail opens as a catalogue title, with the
 *  media server's own copy leading Play even where the sort would put an addon row first. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class RemoteDetailRelatedShellTest {

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

  @Test
  fun `a similar title from a media-server detail starts on that server's copy`() {
    val card = HomeCard.Remote(key = "remote:one", title = "Movie", provider = "jellyfin",
      libraryId = "rlibA", libraryName = "Filmy", itemId = "iA")
    val encoded = HomeCardsJson.encodeToJsonElement(HomeCard.serializer(), card) as JsonObject
    val api = FakeTvApi().apply {
      settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", streamSort = "size-desc", realDebridConfigured = true)
      homeHandler = { _ ->
        HomeResponseDto(order = listOf(HomeOrderEntry("resume")), rows = mapOf("resume" to HomeRowDto(items = listOf(encoded))))
      }
      remoteSourcesValue = listOf(StreamDto(sourceId = "remote1", kind = "remote", playable = true,
        remoteItem = RemoteItemContext(libraryId = "rlibA", itemId = "iA", mediaSourceId = "v1", progressKey = "remote:one")))
      remoteItemValues["rlibA:iA"] = RemoteItemDetailDto(
        RemoteItemDto(id = "iA", name = "Movie", type = "movie", providerIds = RemoteProviderIdsDto(imdb = "tt1")),
      )
      titleExtrasValue = TitleExtrasDto(related = listOf(RelatedTitleDto(type = "movie", id = "tt2", name = "Related")))
      metaValues["movie:tt2"] = MetaDto(id = "tt2", type = "movie", name = "Related")
      remoteLibrariesValue = listOf(RemoteLibraryDto(id = "rlibA", name = "Filmy", provider = "jellyfin"))
      remoteMatchValues["rlibA|movie|tt2"] = listOf(StreamDto(
        sourceId = "ms2", kind = "remote", playable = true, name = "FullHD", provider = "jellyfin", libraryName = "Filmy",
        behaviorHints = BehaviorHintsDto(videoSize = 2e9),
        remoteItem = RemoteItemContext(libraryId = "rlibA", itemId = "iB", mediaSourceId = "ms2", progressKey = "remote:rlibA:iB"),
      ))
      streamSourcesValues["movie:tt2"] = listOf(StreamSourceDto("alpha", "Alpha"))
      addonStreams["movie:tt2|alpha"] = listOf(StreamDto(sourceId = "s1", kind = "remote", playable = true,
        title = "Addon 4K", addonName = "Alpha", behaviorHints = BehaviorHintsDto(videoSize = 8e9)))
    }
    scenario.onActivity { activity ->
      activity.setContent { Shell(start = Section.Home, api = api, username = "demo", onSignOut = {}) }
    }
    compose.waitForIdle()
    compose.onNodeWithTag(homeCardTag(card.key)).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { runCatching { compose.onNodeWithTag(TagRemoteDetailPlay).assertIsFocused() }.isSuccess }
    compose.waitUntil(5_000) { runCatching { compose.onNodeWithTag(relatedTitleTag("tt2")).assertExists() }.isSuccess }
    compose.onNodeWithTag(relatedTitleTag("tt2")).performSemanticsAction(SemanticsActions.RequestFocus)
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagCatalogPrimary).assertExists()
    compose.waitUntil(5_000) { api.remoteMatchRequests.contains("rlibA|movie|tt2") }
    compose.waitForIdle()
    compose.onNodeWithTag(TagCatalogChosenSource).assertTextContains("jellyfin", substring = true)
  }
}
