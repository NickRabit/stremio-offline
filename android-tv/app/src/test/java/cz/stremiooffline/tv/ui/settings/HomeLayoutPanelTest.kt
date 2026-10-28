@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.settings

import android.content.Context
import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.remember
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.HomeLayoutDto
import cz.stremiooffline.tv.data.HomeLayoutEntryDto
import cz.stremiooffline.tv.data.HomeLayoutResponseDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.ui.FakeTvApi
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The Home-arrangement panel: its row order, the nested action list, reset and the save. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class HomeLayoutPanelTest {

  @get:Rule val compose = createEmptyComposeRule()

  private lateinit var scenario: ActivityScenario<ComponentActivity>

  private val context: Context get() = ApplicationProvider.getApplicationContext()

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

  private fun entry(id: String, kind: String, label: String, shown: Boolean = true) =
    HomeLayoutEntryDto(id = id, kind = kind, label = label, shown = shown, added = true)

  private fun fake() = FakeTvApi().apply {
    settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", subtitleLanguage = "cs", startView = "home")
    homeLayoutValue = HomeLayoutResponseDto(
      rows = listOf(
        entry("resume", "builtin", "home.continue"),
        entry("favorites", "builtin", "home.favorites"),
        entry("tonight", "builtin", "home.tonight"),
      ),
      layout = HomeLayoutDto(order = listOf("resume", "favorites", "tonight")),
    )
  }

  private fun mount(api: FakeTvApi) {
    scenario.onActivity { activity ->
      activity.setContent {
        SettingsRoute(
          api = api,
          username = "demo",
          focusRequester = remember { FocusRequester() },
          onSignOut = {},
          onLocale = {},
        )
      }
    }
    compose.waitForIdle()
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  /** From the Server row the Home row is the eighth; OK opens the panel on its first row. */
  private fun openPanel() {
    repeat(7) { press(Key.DirectionDown) }
    compose.onNodeWithTag(TagSettingsRowHomeLayout).assertIsFocused()
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSettingsPanel).assertExists()
  }

  private fun save() {
    compose.mainClock.advanceTimeBy(HOME_LAYOUT_SAVE_MS + 50)
    compose.waitForIdle()
  }

  /** OK on the focused row: the nested actions open on the show/hide switch. */
  private fun openActions() {
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagHomeRowActions).assertExists()
    compose.onNodeWithTag(TagHomeActionToggle).assertIsFocused()
  }

  private fun chooseMove(actionTag: String, downs: Int) {
    openActions()
    repeat(downs) { press(Key.DirectionDown) }
    compose.onNodeWithTag(actionTag).assertIsFocused()
    press(Key.DirectionCenter)
  }

  @Test
  fun `the panel lists the rows in the account's order`() {
    mount(fake())
    openPanel()

    compose.onNodeWithTag(homeLayoutRowTag("resume")).assertIsFocused()
    press(Key.DirectionDown); compose.onNodeWithTag(homeLayoutRowTag("favorites")).assertIsFocused()
    press(Key.DirectionDown); compose.onNodeWithTag(homeLayoutRowTag("tonight")).assertIsFocused()
    press(Key.DirectionDown); compose.onNodeWithTag(TagHomeLayoutReset).assertIsFocused()
    compose.onNodeWithTag(TagHomeLayoutNote).assertExists()
  }

  @Test
  fun `OK hides a row and the PATCH carries the hidden id`() {
    val api = fake()
    mount(api)
    openPanel()

    compose.onNodeWithTag(homeLayoutRowTag("resume")).assertIsFocused()
    openActions()
    press(Key.DirectionCenter)

    compose.onNodeWithTag(homeLayoutRowTag("resume")).assertTextContains(context.getString(R.string.tv_home_layout_hidden), substring = true)
    compose.onNodeWithTag(TagHomeRowActions).assertDoesNotExist()
    compose.onNodeWithTag(homeLayoutRowTag("resume")).assertIsFocused()
    assertEquals(0, api.homeLayoutPatches.size)
    save()
    assertEquals(listOf("resume"), api.homeLayoutPatches.single()!!.hidden)
  }

  @Test
  fun `Move down moves a row one place and the PATCH carries the new order`() {
    val api = fake()
    mount(api)
    openPanel()
    compose.onNodeWithTag(homeLayoutRowTag("resume")).assertIsFocused()

    chooseMove(TagHomeActionDown, downs = 2)
    compose.onNodeWithTag(homeLayoutRowTag("resume")).assertIsFocused()

    save()
    assertEquals(listOf("favorites", "resume", "tonight"), api.homeLayoutPatches.single()!!.order)
  }

  @Test
  fun `Move to the top moves a row two places and the PATCH carries the new order`() {
    val api = fake()
    mount(api)
    openPanel()
    press(Key.DirectionDown)
    press(Key.DirectionDown)
    compose.onNodeWithTag(homeLayoutRowTag("tonight")).assertIsFocused()

    chooseMove(TagHomeActionTop, downs = 3)

    compose.onNodeWithTag(homeLayoutRowTag("tonight")).assertIsFocused()
    save()
    assertEquals(listOf("tonight", "resume", "favorites"), api.homeLayoutPatches.single()!!.order)
  }

  @Test
  fun `Back leaves the action list and returns focus to the same row`() {
    val api = fake()
    mount(api)
    openPanel()

    press(Key.DirectionDown)
    compose.onNodeWithTag(homeLayoutRowTag("favorites")).assertIsFocused()
    openActions()
    scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()

    compose.onNodeWithTag(TagSettingsPanel).assertExists()
    compose.onNodeWithTag(TagHomeRowActions).assertDoesNotExist()
    compose.onNodeWithTag(homeLayoutRowTag("favorites")).assertIsFocused()
    assertEquals(0, api.homeLayoutPatches.size)
  }

  @Test
  fun `Reset to default clears the arrangement`() {
    val api = fake()
    mount(api)
    openPanel()

    repeat(3) { press(Key.DirectionDown) }
    compose.onNodeWithTag(TagHomeLayoutReset).assertIsFocused()
    press(Key.DirectionCenter)

    save()
    assertEquals(1, api.homeLayoutPatches.size)
    assertNull(api.homeLayoutPatches.single())
  }

  @Test
  fun `closing the panel flushes a save still waiting`() {
    val api = fake()
    mount(api)
    openPanel()

    openActions()
    press(Key.DirectionCenter)
    assertEquals(0, api.homeLayoutPatches.size)

    scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()

    compose.onNodeWithTag(TagSettingsPanel).assertDoesNotExist()
    assertEquals(listOf("resume"), api.homeLayoutPatches.single()!!.hidden)
  }

  @Test
  fun `a rejected write puts the row back and shows the server's message`() {
    val api = fake()
    api.homeLayoutPatchFailure = ApiFailure.Forbidden
    api.homeLayoutPatchMessage = "Home layouts are turned off."
    mount(api)
    openPanel()

    openActions()
    press(Key.DirectionCenter)
    save()

    compose.onNodeWithTag(TagHomeLayoutError).assertTextContains("Home layouts are turned off.", substring = true)
    compose.onNodeWithTag(homeLayoutRowTag("resume")).assertTextContains(context.getString(R.string.tv_home_layout_shown), substring = true)
  }

  @Test
  fun `a server without the route shows the unavailable row and OK does nothing`() {
    val api = fake()
    api.homeLayoutFailure = ApiFailure.NotFound
    mount(api)

    compose.onNodeWithTag(TagSettingsRowHomeLayout)
      .assertTextContains(context.getString(R.string.tv_home_layout_unavailable), substring = true)

    repeat(7) { press(Key.DirectionDown) }
    compose.onNodeWithTag(TagSettingsRowHomeLayout).assertIsFocused()
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSettingsPanel).assertDoesNotExist()
  }

  @Test
  fun `a feed row is labelled with its add-on, catalogue and type`() {
    val api = fake()
    api.homeLayoutValue = HomeLayoutResponseDto(
      rows = listOf(entry("catalog:cinemeta:movie:top", "feed", "Cinemeta · Popular")),
      layout = HomeLayoutDto(order = listOf("catalog:cinemeta:movie:top")),
    )
    mount(api)
    openPanel()

    compose.onNodeWithText("Cinemeta · Popular (movie)").assertExists()
  }

  @Test
  fun `confirm offers only the show and hide switch, with no move actions`() {
    val api = fake()
    api.homeLayoutValue = HomeLayoutResponseDto(
      rows = listOf(entry("confirm", "builtin", "home.toConfirm")),
      layout = HomeLayoutDto(order = listOf("confirm")),
    )
    mount(api)
    openPanel()

    compose.onNodeWithTag(homeLayoutRowTag("confirm")).assertIsFocused()
    openActions()
    compose.onNodeWithTag(TagHomeActionUp).assertDoesNotExist()
    compose.onNodeWithTag(TagHomeActionDown).assertDoesNotExist()
    compose.onNodeWithTag(TagHomeActionTop).assertDoesNotExist()
    press(Key.DirectionCenter)
    save()
    assertEquals(listOf("confirm"), api.homeLayoutPatches.single()!!.hidden)
  }

  @Test
  fun `the panel reads the arrangement again every time it opens`() {
    val api = fake()
    mount(api)
    assertEquals(1, api.homeLayoutRequests)

    openPanel()
    assertEquals(2, api.homeLayoutRequests)

    // A change made elsewhere (the web, another device) is picked up on the next open.
    api.homeLayoutValue = HomeLayoutResponseDto(
      rows = listOf(
        entry("resume", "builtin", "home.continue"),
        entry("favorites", "builtin", "home.favorites"),
        entry("tonight", "builtin", "home.tonight"),
        entry("recent", "builtin", "home.recent"),
      ),
      layout = HomeLayoutDto(order = listOf("resume", "favorites", "tonight", "recent")),
    )
    scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()
    compose.onNodeWithTag(TagSettingsRowHomeLayout).assertIsFocused()

    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSettingsPanel).assertExists()
    assertEquals(3, api.homeLayoutRequests)
    compose.onNodeWithTag(homeLayoutRowTag("recent")).assertExists()
  }

  @Test
  fun `a failed save reads the arrangement again`() {
    val api = fake()
    api.homeLayoutPatchFailure = ApiFailure.Forbidden
    mount(api)
    openPanel()
    assertEquals(2, api.homeLayoutRequests)

    openActions()
    press(Key.DirectionCenter)
    save()

    assertEquals(3, api.homeLayoutRequests)
  }

  @Test
  fun `a read that is not a 404 shows the message and retries on the next open`() {
    val api = fake()
    api.homeLayoutFailure = ApiFailure.Generic
    api.homeLayoutFailureMessage = "Home layouts are turned off."
    mount(api)

    compose.onNodeWithTag(TagSettingsRowHomeLayout)
      .assertTextContains("Home layouts are turned off.", substring = true)

    api.homeLayoutFailure = null
    repeat(7) { press(Key.DirectionDown) }
    compose.onNodeWithTag(TagSettingsRowHomeLayout).assertIsFocused()
    press(Key.DirectionCenter)
    compose.onNodeWithTag(homeLayoutRowTag("resume")).assertIsFocused()
  }

  @Test
  fun `an empty arrangement carries the focus to the reset row`() {
    val api = fake()
    api.homeLayoutValue = HomeLayoutResponseDto(rows = emptyList(), layout = HomeLayoutDto())
    mount(api)
    openPanel()

    compose.onNodeWithTag(TagHomeLayoutReset).assertIsFocused()
  }
}
