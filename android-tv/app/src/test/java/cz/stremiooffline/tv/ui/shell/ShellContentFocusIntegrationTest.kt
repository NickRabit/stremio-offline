@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.BrowseResult
import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.HomeCardsJson
import cz.stremiooffline.tv.data.HomeOrderEntry
import cz.stremiooffline.tv.data.HomeResponseDto
import cz.stremiooffline.tv.data.HomeRowDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.TagSearchField
import cz.stremiooffline.tv.ui.home.homeCardTag
import cz.stremiooffline.tv.ui.settings.TagSettingsRowServer
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class ShellContentFocusIntegrationTest {

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

  private fun mount(section: Section, api: FakeTvApi) {
    scenario.onActivity { activity ->
      activity.setContent { Shell(start = section, api = api, username = "demo", onSignOut = {}) }
    }
    compose.waitForIdle()
  }

  private fun rightIntoAndLeftBack(section: Section, contentTag: String) {
    compose.onNodeWithTag(railTag(section)).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
    compose.onNodeWithTag(railTag(section)).performKeyInput { pressKey(Key.DirectionRight) }
    compose.waitForIdle()
    compose.onNodeWithTag(contentTag).assertIsFocused()

    compose.onNodeWithTag(contentTag).performKeyInput { pressKey(Key.DirectionLeft) }
    compose.waitForIdle()
    compose.onNodeWithTag(railTag(section)).assertIsFocused()
  }

  @Test
  fun `Search rail enters the real search field and left returns`() {
    val api = FakeTvApi()
    mount(Section.Search, api)
    compose.waitUntil(5_000) {
      compose.onAllNodes(androidx.compose.ui.test.hasTestTag(TagSearchField)).fetchSemanticsNodes().isNotEmpty()
    }
    rightIntoAndLeftBack(Section.Search, TagSearchField)
  }

  @Test
  fun `Library rail enters the real All grid and left returns`() {
    val api = FakeTvApi().apply {
      pages[null] = BrowseResult("", listOf(BrowseItem.Library(path = "Films", name = "Films")), 1, false)
    }
    mount(Section.Library, api)
    compose.waitUntil(5_000) {
      compose.onAllNodes(androidx.compose.ui.test.hasTestTag("all_local:Films")).fetchSemanticsNodes().isNotEmpty()
    }
    rightIntoAndLeftBack(Section.Library, "all_local:Films")
  }

  @Test
  fun `Home rail enters the real first card and left returns`() {
    val api = FakeTvApi()
    val card = HomeCard.ResumeFile(key = "k1", title = "First", path = "Films/First.mkv")
    api.homeHandler = { asked ->
      if (asked.isEmpty()) {
        HomeResponseDto(order = listOf(HomeOrderEntry("resume")))
      } else {
        HomeResponseDto(
          order = listOf(HomeOrderEntry("resume")),
          rows = mapOf(
            "resume" to HomeRowDto(items = listOf(HomeCardsJson.encodeToJsonElement(HomeCard.serializer(), card) as JsonObject)),
          ),
        )
      }
    }
    mount(Section.Home, api)
    compose.waitUntil(5_000) {
      compose.onAllNodes(androidx.compose.ui.test.hasTestTag(homeCardTag("k1"))).fetchSemanticsNodes().isNotEmpty()
    }
    rightIntoAndLeftBack(Section.Home, homeCardTag("k1"))
  }

  @Test
  fun `Account rail enters its own first row without a second boundary requester`() {
    val api = FakeTvApi()
    mount(Section.Account, api)
    compose.waitUntil(5_000) {
      compose.onAllNodes(androidx.compose.ui.test.hasTestTag(TagSettingsRowServer)).fetchSemanticsNodes().isNotEmpty()
    }
    rightIntoAndLeftBack(Section.Account, TagSettingsRowServer)
  }
}
