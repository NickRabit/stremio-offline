@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.StreamSourceDto
import cz.stremiooffline.tv.ui.FakeTvApi
import kotlinx.coroutines.CompletableDeferred
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Back is the activity's dispatcher, not a D-pad key, so this needs a real host. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class CatalogDetailBackTest {

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

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun focused(tag: String): Boolean =
    compose.onAllNodes(isFocused()).fetchSemanticsNodes()
      .any { it.config.getOrElse(SemanticsProperties.TestTag) { "" } == tag }

  @Test
  fun `Back closes the sources panel and hands the remote back to the Sources button`() {
    val api = FakeTvApi()
    api.settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", realDebridConfigured = true)
    api.streamsValues["movie:tt1"] = listOf(StreamDto(sourceId = "s1", kind = "remote", playable = true, name = "FullHD"))
    scenario.onActivity { activity ->
      host = activity
      activity.setContent {
        CatalogDetailScreen(
          api = api,
          args = CatalogDetailArgs(MetaDto(id = "tt1", type = "movie", name = "It"), "Cinemeta", "movie"),
          imageUrl = { null },
          onPlay = {},
          onBack = {},
        )
      }
    }
    compose.waitForIdle()

    var guard = 0
    while (!focused(TagCatalogSources) && guard++ < 6) press(Key.DirectionRight)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSourcesPanel).assertExists()
    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()

    compose.onNodeWithTag(TagSourcesPanel).assertDoesNotExist()
    compose.onNodeWithTag(TagCatalogSources).assertIsFocused()
  }

  @Test
  fun `Back while a play waits on the sources drops the wait instead of leaving`() {
    val api = FakeTvApi()
    api.settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", realDebridConfigured = true)
    api.streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
    api.addonStreams["movie:tt1|alpha"] = listOf(StreamDto(sourceId = "s1", kind = "remote", playable = true, title = "Czech 1 GB", addonName = "Alpha"))
    api.streamsGates["movie:tt1|alpha"] = CompletableDeferred()
    var backs = 0
    scenario.onActivity { activity ->
      host = activity
      activity.setContent {
        CatalogDetailScreen(
          api = api,
          args = CatalogDetailArgs(MetaDto(id = "tt1", type = "movie", name = "It"), "Cinemeta", "movie"),
          imageUrl = { null },
          onPlay = {},
          onBack = { backs++ },
        )
      }
    }
    compose.waitForIdle()

    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagCatalogPrimary).assertTextContains("Starting when sources are ready…")

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()

    assertEquals(0, backs)
    compose.onNodeWithTag(TagCatalogPrimary).assertTextContains("Finding sources…")
  }
}
