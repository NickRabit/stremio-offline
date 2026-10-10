@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.StreamSourceDto
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

/** How the sources of one title arrive: addon by addon, in parallel, merged as they land. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class CatalogSourcesTest {

  @get:Rule val compose = createComposeRule()

  private val played = mutableListOf<PlayTarget>()

  private fun settings() = SettingsResponse(uiLanguage = "en", audioLanguage = "en", streamSort = "recommended", realDebridConfigured = true)

  private fun source(key: String) = StreamSourceDto(key, key.replaceFirstChar { it.uppercase() })

  private fun stream(sourceId: String, title: String, addonName: String) =
    StreamDto(sourceId = sourceId, kind = "remote", playable = true, title = title, addonName = addonName)

  private fun mount(api: FakeTvApi) {
    compose.setContent {
      CatalogDetailScreen(
        api = api,
        args = CatalogDetailArgs(MetaDto(id = "tt1", type = "movie", name = "It", description = "A film"), "Cinemeta", "movie"),
        imageUrl = { null },
        onPlay = { played += it },
        onBack = {},
      )
    }
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun focused(tag: String): Boolean =
    compose.onAllNodes(isFocused()).fetchSemanticsNodes()
      .any { it.config.getOrElse(SemanticsProperties.TestTag) { "" } == tag }

  private fun focusSources() {
    repeat(6) {
      if (focused(TagCatalogSources)) return
      press(Key.DirectionRight)
    }
    compose.onNodeWithTag(TagCatalogSources).assertIsFocused()
  }

  private fun twoAddons(api: FakeTvApi): CompletableDeferred<Unit> {
    api.settingsValue = settings()
    api.streamSourcesValues["movie:tt1"] = listOf(source("alpha"), source("beta"))
    api.addonStreams["movie:tt1|alpha"] = listOf(stream("srcA", "Czech 1 GB", "Alpha"))
    api.addonStreams["movie:tt1|beta"] = listOf(stream("srcB", "Czech 8 GB", "Beta"))
    val beta = CompletableDeferred<Unit>()
    api.streamsGates["movie:tt1|beta"] = beta
    return beta
  }

  @Test
  fun `the first addon is shown and playable before the slow one answers`() {
    val api = FakeTvApi()
    val beta = twoAddons(api)
    mount(api)
    compose.waitUntil(5_000) { api.streamsCompleted.contains("movie:tt1|alpha") }
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogSources).assertTextContains("Sources · 1")
    // The slow addon has not answered, so it cannot have been merged yet.
    assertTrue(api.streamsCompleted.none { it == "movie:tt1|beta" })
    press(Key.DirectionCenter)
    assertEquals(listOf("srcA"), played.map { it.sourceId })

    beta.complete(Unit)
    compose.waitUntil(5_000) { api.streamsCompleted.contains("movie:tt1|beta") }
    compose.waitForIdle()
    compose.onNodeWithTag(TagCatalogSources).assertTextContains("Sources · 2")
  }

  @Test
  fun `a better source that lands while the rest are still coming becomes the default`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamSourcesValues["movie:tt1"] = listOf(source("alpha"), source("beta"), source("gamma"))
    api.addonStreams["movie:tt1|alpha"] = listOf(stream("srcA", "Czech 1 GB", "Alpha"))
    api.addonStreams["movie:tt1|beta"] = listOf(stream("srcB", "Czech 8 GB", "Beta"))
    api.addonStreams["movie:tt1|gamma"] = emptyList()
    val beta = CompletableDeferred<Unit>()
    val gamma = CompletableDeferred<Unit>()
    api.streamsGates["movie:tt1|beta"] = beta
    api.streamsGates["movie:tt1|gamma"] = gamma
    mount(api)
    compose.waitUntil(5_000) { api.streamsCompleted.contains("movie:tt1|alpha") }
    compose.waitForIdle()

    focusSources()
    press(Key.DirectionCenter)
    // Only Alpha has answered, so its row is the ticked default.
    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()
    compose.onNodeWithTag(sourceRowTag(0)).assertTextContains("Czech 1 GB")

    beta.complete(Unit)
    compose.waitUntil(5_000) { api.streamsCompleted.contains("movie:tt1|beta") }
    compose.waitForIdle()

    // The larger source outranks Alpha while Gamma is still pending, the web's repick rule.
    compose.onNodeWithTag(sourceRowTag(0)).assertTextContains("Czech 8 GB")
    compose.onNodeWithTag(sourceRowTag(0)).assertTextContains("Default", substring = true)

    gamma.complete(Unit)
    compose.waitUntil(5_000) { api.streamsCompleted.contains("movie:tt1|gamma") }
    compose.waitForIdle()
    // Once every addon answered the default no longer moves.
    compose.onNodeWithTag(sourceRowTag(0)).assertTextContains("Czech 8 GB")
  }

  // Found on the owner's server: the detail waited for every addon before it showed anything.
  @Test
  fun `the title's requests are all issued at once`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.progressListGate = CompletableDeferred<Unit>()
    mount(api)
    compose.waitUntil(5_000) { api.progressListCalls >= 1 && api.watchlistCalls >= 1 }

    assertTrue(api.settingsCalls >= 1)
    assertTrue(api.addonsCalls >= 1)
    assertTrue(api.watchlistCalls >= 1)
    assertTrue(api.metaRequests.isNotEmpty())

    api.progressListGate!!.complete(Unit)
    compose.waitForIdle()
  }
}
