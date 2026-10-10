@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.input.key.Key
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
import cz.stremiooffline.tv.ui.home.homeCardTag
import cz.stremiooffline.tv.ui.library.TagLibraryBreadcrumb
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The account's Start page setting of `home` lands on Home, focused on its first card. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class HomeStartTest {

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

  @Test
  fun `the home start view selects the Home section`() {
    assertEquals(Section.Home, startSection("home"))
  }

  @Test
  fun `starting on home focuses the first card of the first row`() {
    val api = FakeTvApi()
    val card = HomeCard.ResumeFile(key = "k1", title = "First", path = "browse/k1", progress = null)
    api.homeHandler = { asked ->
      if (asked.isEmpty()) HomeResponseDto(order = listOf(HomeOrderEntry("resume")))
      else HomeResponseDto(
        order = listOf(HomeOrderEntry("resume")),
        rows = mapOf(
          "resume" to HomeRowDto(items = listOf(HomeCardsJson.encodeToJsonElement(HomeCard.serializer(), card) as JsonObject)),
        ),
      )
    }

    scenario.onActivity { activity ->
      activity.setContent { Shell(start = Section.Home, api = api, username = "demo", onSignOut = {}) }
    }
    compose.waitForIdle()

    compose.onNodeWithTag(homeCardTag("k1")).assertIsFocused()
  }

  @Test
  fun `ok on a folder favourite switches to the library at that folder`() {
    val api = FakeTvApi()
    val card = HomeCard.Favorite(key = "folder:f", path = "browse/Films", itemKind = "folder", label = "Films")
    api.homeHandler = { asked ->
      if (asked.isEmpty()) HomeResponseDto(order = listOf(HomeOrderEntry("favorites")))
      else HomeResponseDto(
        order = listOf(HomeOrderEntry("favorites")),
        rows = mapOf(
          "favorites" to HomeRowDto(items = listOf(HomeCardsJson.encodeToJsonElement(HomeCard.serializer(), card) as JsonObject)),
        ),
      )
    }
    api.pages["browse/Films"] = BrowseResult(
      "browse/Films",
      listOf(BrowseItem.Folder(path = "browse/Films/It", name = "It", fileCount = 1)),
      1,
      false,
    )

    scenario.onActivity { activity ->
      activity.setContent { Shell(start = Section.Home, api = api, username = "demo", onSignOut = {}) }
    }
    compose.waitForIdle()
    compose.onNodeWithTag(homeCardTag("folder:f")).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    assertTrue(api.browseCalls.any { it.first == "browse/Films" })
  }

  @Test
  fun `a folder jump pushes onto the library root and Back leaves the folder`() {
    val api = FakeTvApi()
    val card = HomeCard.Favorite(key = "folder:f", path = "browse/Films", itemKind = "folder", label = "Films")
    api.homeHandler = { asked ->
      if (asked.isEmpty()) HomeResponseDto(order = listOf(HomeOrderEntry("favorites")))
      else HomeResponseDto(
        order = listOf(HomeOrderEntry("favorites")),
        rows = mapOf(
          "favorites" to HomeRowDto(items = listOf(HomeCardsJson.encodeToJsonElement(HomeCard.serializer(), card) as JsonObject)),
        ),
      )
    }
    api.pages[null] = BrowseResult("", listOf(BrowseItem.Library(path = "browse", name = "Films", fileCount = 1)), 1, false)
    api.pages["browse/Films"] = BrowseResult(
      "browse/Films",
      listOf(BrowseItem.Folder(path = "browse/Films/It", name = "It", fileCount = 1)),
      1,
      false,
    )

    scenario.onActivity { activity ->
      activity.setContent { Shell(start = Section.Home, api = api, username = "demo", onSignOut = {}) }
    }
    compose.waitForIdle()
    compose.onNodeWithTag(homeCardTag("folder:f")).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    // The jump pushed the folder onto the root instead of replacing it: the breadcrumb is shown.
    compose.onNodeWithTag(TagLibraryBreadcrumb).assertExists()

    // Back pops the folder and stays in the library.
    scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()
    compose.onNodeWithTag(TagLibraryBreadcrumb).assertDoesNotExist()
  }
}
