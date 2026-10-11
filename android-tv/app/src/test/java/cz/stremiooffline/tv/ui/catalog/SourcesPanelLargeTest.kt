@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.FakeTvApi
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A title with hundreds of offered sources used to grind the real TV to a halt. The panel is a
 * lazy list now, so opening it and walking down it stays responsive.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class SourcesPanelLargeTest {

  @get:Rule val compose = createComposeRule()

  private fun mount(api: FakeTvApi) {
    compose.setContent {
      CatalogDetailScreen(
        api = api,
        args = CatalogDetailArgs(MetaDto(id = "tt1", type = "movie", name = "It"), "Cinemeta", "movie"),
        imageUrl = { null },
        onPlay = {},
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

  @Test
  fun `six hundred sources open the panel and DOWN reaches row fifty`() {
    val api = FakeTvApi()
    api.settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", realDebridConfigured = true)
    api.streamsValues["movie:tt1"] = (0 until 600).map {
      StreamDto(sourceId = "s$it", kind = "remote", playable = true, title = "Czech ${it} GB", addonName = "alpha")
    }
    mount(api)
    compose.waitForIdle()

    focusSources()
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSourcesPanel).assertExists()
    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()

    val started = System.currentTimeMillis()
    repeat(50) { press(Key.DirectionDown) }
    val elapsed = System.currentTimeMillis() - started

    compose.onNodeWithTag(sourceRowTag(50)).assertIsFocused()
    // Generous: the point is that the walk does not lock up, not a device benchmark.
    assertTrue("DOWN to row 50 took ${elapsed}ms", elapsed < 30_000)
  }
}
