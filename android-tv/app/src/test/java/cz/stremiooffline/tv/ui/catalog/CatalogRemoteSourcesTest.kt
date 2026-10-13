@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteLibraryDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.StreamSourceDto
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.ui.FakeTvApi
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The remote source groups beside the addons: a failed library is a note, never a lid over the
 *  rows the viewer can still play, and the player's own Retry re-reads the remote side alone. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class CatalogRemoteSourcesTest {

  @get:Rule val compose = createComposeRule()

  private fun settings() =
    SettingsResponse(uiLanguage = "en", audioLanguage = "en", streamSort = "recommended", realDebridConfigured = true)

  private fun addonStream(sourceId: String) =
    StreamDto(sourceId = sourceId, kind = "remote", playable = true, title = "Addon $sourceId", addonName = "Alpha")

  private fun remoteStream(sourceId: String, libraryId: String) = StreamDto(
    sourceId = sourceId,
    kind = "remote",
    playable = true,
    name = "FullHD",
    provider = "jellyfin",
    libraryName = "Filmy",
    remoteItem = RemoteItemContext(
      libraryId = libraryId,
      itemId = "iA",
      mediaSourceId = sourceId,
      progressKey = "remote:$libraryId:iA",
    ),
  )

  private fun movieArgs() = CatalogDetailArgs(MetaDto(id = "tt1", type = "movie", name = "It"), "Cinemeta", "movie")

  @Test
  fun `a series episode asks the provider with the series name, never the episode's own`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.remoteLibrariesValue = listOf(RemoteLibraryDto(id = "rlibA", name = "Filmy", provider = "jellyfin"))
    val episode = VideoDto(id = "tt1:1:2", title = "Episode Two", season = 1, episode = 2)
    api.metaValues["series:tt1"] = MetaDto(id = "tt1", type = "series", name = "The Show", videos = listOf(episode))
    api.remoteMatchValues["rlibA|series|tt1:1:2"] = listOf(remoteStream("a1", "rlibA"))
    compose.setContent {
      CatalogDetailScreen(
        api = api,
        args = CatalogDetailArgs(MetaDto(id = "tt1", type = "series", name = "The Show"), "Cinemeta", "series"),
        imageUrl = { null },
        onPlay = {},
        onBack = {},
      )
    }
    compose.waitUntil(5_000) { api.remoteMatchRequests.contains("rlibA|series|tt1:1:2") }
    compose.waitForIdle()

    val hint = api.remoteMatchHints[api.remoteMatchRequests.indexOf("rlibA|series|tt1:1:2")]
    assertEquals("The Show", hint)
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun focused(tag: String): Boolean =
    compose.onAllNodes(isFocused()).fetchSemanticsNodes()
      .any { it.config.getOrElse(SemanticsProperties.TestTag) { "" } == tag }

  private fun openSources() {
    repeat(6) {
      if (!focused(TagCatalogSources)) press(Key.DirectionRight)
    }
    compose.onNodeWithTag(TagCatalogSources).assertIsFocused()
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSourcesPanel).assertExists()
  }

  @Test
  fun `a chosen remote library with matches is not hidden by another group's failure`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.remoteLibrariesValue = listOf(
      RemoteLibraryDto(id = "rlibA", name = "Filmy", provider = "jellyfin"),
      RemoteLibraryDto(id = "rlibB", name = "Serialy", provider = "emby"),
    )
    api.remoteMatchValues["rlibA|movie|tt1"] = listOf(remoteStream("a1", "rlibA"))
    api.remoteMatchFailures += "rlibB|movie|tt1"
    api.streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
    api.addonStreams["movie:tt1|alpha"] = listOf(addonStream("s1"))
    compose.setContent {
      CatalogDetailScreen(api = api, args = movieArgs(), imageUrl = { null }, onPlay = {}, onBack = {})
    }
    compose.waitUntil(5_000) { api.remoteMatchRequests.size >= 2 }
    compose.waitForIdle()

    openSources()
    // The addon menu is All, the healthy remote library, then the addon; pick the remote library.
    compose.onNodeWithTag(sourceFilterTag("addon")).performSemanticsAction(SemanticsActions.RequestFocus) { it() }
    press(Key.DirectionCenter)
    compose.onNodeWithTag(sourceFilterOptionTag(0)).assertIsFocused()
    press(Key.DirectionDown)
    press(Key.DirectionCenter)

    compose.onNodeWithTag(sourceFilterTag("addon")).assertTextContains("jellyfin", substring = true)
    compose.onNodeWithTag(sourceRowTag(0)).assertTextContains("FullHD", substring = true)
    // The failed group is still called out, but as a note with its own Retry beside the row.
    compose.onNodeWithTag(TagCatalogRetry).assertExists()
  }

  @Test
  fun `the external retry re-reads the remote groups without re-running the addon list`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.remoteLibrariesValue = listOf(RemoteLibraryDto(id = "rlibA", name = "Filmy", provider = "jellyfin"))
    api.remoteMatchFailures += "rlibA|movie|tt1"
    api.streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
    api.addonStreams["movie:tt1|alpha"] = listOf(addonStream("s1"))
    val token = mutableStateOf(0)
    compose.setContent {
      CatalogDetailScreen(
        api = api,
        args = movieArgs(),
        imageUrl = { null },
        onPlay = {},
        onBack = {},
        retryToken = token.value,
      )
    }
    compose.waitUntil(5_000) { api.remoteMatchRequests.size == 1 }
    compose.waitForIdle()
    assertEquals(1, api.streamSourcesRequests.size)

    compose.runOnIdle { token.value = 1 }
    compose.waitForIdle()
    compose.waitUntil(5_000) { api.remoteMatchRequests.size == 2 }
    compose.waitForIdle()

    // Only the remote groups were asked again; the addon list (and any chosen source) is untouched.
    assertEquals(1, api.streamSourcesRequests.size)
  }
}
