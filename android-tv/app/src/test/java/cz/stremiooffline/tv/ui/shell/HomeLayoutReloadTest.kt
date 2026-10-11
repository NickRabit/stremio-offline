@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.HomeCardsJson
import cz.stremiooffline.tv.data.HomeLayoutDto
import cz.stremiooffline.tv.data.HomeLayoutEntryDto
import cz.stremiooffline.tv.data.HomeLayoutResponseDto
import cz.stremiooffline.tv.data.HomeOrderEntry
import cz.stremiooffline.tv.data.HomeResponseDto
import cz.stremiooffline.tv.data.HomeRowDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.settings.TagSettingsRowHomeLayout
import cz.stremiooffline.tv.ui.settings.TagSettingsRowServer
import cz.stremiooffline.tv.ui.settings.TagHomeActionToggle
import cz.stremiooffline.tv.ui.settings.homeLayoutRowTag
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Home has to read its rows again once Settings has changed the arrangement and it returns. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class HomeLayoutReloadTest {

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

  private fun isFocusedOn(tag: String): Boolean =
    compose.onAllNodes(isFocused()).fetchSemanticsNodes()
      .any { it.config.getOrElse(SemanticsProperties.TestTag) { "" } == tag }

  private fun railTo(section: Section, key: Key) {
    press(Key.DirectionLeft)
    var guard = 0
    while (!isFocusedOn(railTag(section)) && guard++ < 8) press(key)
    compose.onNodeWithTag(railTag(section)).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitForIdle()
  }

  @Test
  fun `home re-reads its rows after Settings changes the arrangement`() {
    val api = FakeTvApi()
    api.homeLayoutValue = HomeLayoutResponseDto(
      rows = listOf(
        HomeLayoutEntryDto(id = "resume", kind = "builtin", label = "home.continue", added = true),
        HomeLayoutEntryDto(id = "favorites", kind = "builtin", label = "home.favorites", added = true),
      ),
      layout = HomeLayoutDto(order = listOf("resume", "favorites")),
    )
    val card = HomeCard.ResumeFile(key = "k1", title = "First", path = "browse/k1", progress = null)
    val item = HomeCardsJson.encodeToJsonElement(HomeCard.serializer(), card) as JsonObject
    api.homeHandler = { asked ->
      val order = listOf(HomeOrderEntry("resume"), HomeOrderEntry("favorites"))
      if (asked.isEmpty()) HomeResponseDto(order = order)
      else HomeResponseDto(order = order, rows = mapOf("resume" to HomeRowDto(items = listOf(item))))
    }

    scenario.onActivity { activity ->
      activity.setContent { Shell(start = Section.Home, api = api, username = "demo", onSignOut = {}) }
    }
    compose.waitForIdle()
    val probesBefore = api.homeRequests.count { it.isEmpty() }

    railTo(Section.Account, Key.DirectionDown)
    compose.onNodeWithTag(TagSettingsRowServer).assertExists()
    repeat(6) { press(Key.DirectionDown) }
    compose.onNodeWithTag(TagSettingsRowHomeLayout).assertIsFocused()
    press(Key.DirectionCenter)
    compose.onNodeWithTag(homeLayoutRowTag("resume")).assertIsFocused()
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagHomeActionToggle).assertIsFocused()
    press(Key.DirectionCenter)
    scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()

    railTo(Section.Home, Key.DirectionUp)

    assertTrue("Home did not ask again after the arrangement changed", api.homeRequests.count { it.isEmpty() } > probesBefore)
  }
}
