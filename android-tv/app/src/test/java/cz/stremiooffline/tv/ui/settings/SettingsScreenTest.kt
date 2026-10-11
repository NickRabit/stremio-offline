@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.settings

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.remember
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.ui.FakeTvApi
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The Settings screen the account rail item opens: focus order, the panels and the one-field
 *  settings writes. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class SettingsScreenTest {

  @get:Rule val compose = createEmptyComposeRule()

  private lateinit var scenario: ActivityScenario<ComponentActivity>
  private var signOuts = 0
  private val appliedLocales = mutableListOf<String>()

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

  private fun fake() = FakeTvApi().apply {
    settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", subtitleLanguage = "cs", startView = "home")
  }

  private fun mount(api: FakeTvApi) {
    scenario.onActivity { activity ->
      activity.setContent {
        SettingsRoute(
          api = api,
          username = "demo",
          focusRequester = remember { FocusRequester() },
          onSignOut = { signOuts++ },
          onLocale = { appliedLocales += it },
        )
      }
    }
    compose.waitForIdle()
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun focusRow(tag: String) {
    compose.onNodeWithTag(tag).assertIsFocused()
  }

  @Test
  fun `the rows take focus in order`() {
    mount(fake())
    focusRow(TagSettingsRowServer)
    press(Key.DirectionDown); focusRow(TagSettingsRowAccount)
    press(Key.DirectionDown); focusRow(TagSettingsRowUiLanguage)
    press(Key.DirectionDown); focusRow(TagSettingsRowAudio)
    press(Key.DirectionDown); focusRow(TagSettingsRowSubtitle)
    press(Key.DirectionDown); focusRow(TagSettingsRowStartView)
    press(Key.DirectionUp); focusRow(TagSettingsRowSubtitle)
  }

  @Test
  fun `the device and version rows are skipped by the D-pad`() {
    mount(fake())
    val notFocusable = SemanticsMatcher.keyNotDefined(SemanticsProperties.Focused)
    compose.onNodeWithTag(TagSettingsRowDevice).assertExists().assert(notFocusable)
    compose.onNodeWithTag(TagSettingsRowVersion).assertExists().assert(notFocusable)

    repeat(5) { press(Key.DirectionDown) }
    focusRow(TagSettingsRowStartView)
    // There is nothing focusable below the last row, so the remote does not leave the list.
    press(Key.DirectionDown)
    focusRow(TagSettingsRowStartView)
  }

  @Test
  fun `the interface language panel lists ten languages and the pick is patched`() {
    val api = fake()
    mount(api)
    press(Key.DirectionDown)
    press(Key.DirectionDown)
    press(Key.DirectionCenter)

    UI_LOCALE_NAMES.forEach { (code, _) -> compose.onNodeWithTag(settingsOptionTag("ui", code)).assertExists() }

    // The panel opens on the current language (English, first); one step down is Czech.
    press(Key.DirectionDown)
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagSettingsPanel).assertDoesNotExist()
    assertEquals(listOf("uiLanguage" to "cs"), api.settingsPatches)
    assertEquals(listOf("cs"), appliedLocales)
    focusRow(TagSettingsRowUiLanguage)
  }

  @Test
  fun `Back closes an open panel without writing anything`() {
    val api = fake()
    mount(api)
    press(Key.DirectionDown)
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSettingsPanel).assertExists()

    scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()

    compose.onNodeWithTag(TagSettingsPanel).assertDoesNotExist()
    assertTrue(api.settingsPatches.isEmpty())
    focusRow(TagSettingsRowUiLanguage)
  }

  @Test
  fun `choosing a preferred audio language writes only that field`() {
    val api = fake()
    mount(api)
    press(Key.DirectionDown)
    press(Key.DirectionDown)
    press(Key.DirectionDown)
    press(Key.DirectionCenter)

    // The panel opens on the current language (English, the fake's second row); one step down
    // is the next offered language.
    press(Key.DirectionDown)
    press(Key.DirectionCenter)

    assertEquals(listOf("audioLanguage" to "de"), api.settingsPatches)
    focusRow(TagSettingsRowAudio)
  }

  @Test
  fun `starting a sign-out opens a panel and only the confirm button signs out`() {
    mount(fake())
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSettingsSignOutCancel).assertExists()
    compose.onNodeWithTag(TagSettingsSignOutConfirm).assertExists()
    assertEquals(0, signOuts)

    // Cancel closes the panel and changes nothing.
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSettingsPanel).assertDoesNotExist()
    assertEquals(0, signOuts)
    focusRow(TagSettingsRowAccount)

    // Reopening and stepping to Sign out confirms.
    press(Key.DirectionCenter)
    press(Key.DirectionRight)
    press(Key.DirectionCenter)
    assertEquals(1, signOuts)
  }

  @Test
  fun `the start page panel writes the start view`() {
    val api = fake()
    mount(api)
    repeat(5) { press(Key.DirectionDown) }
    focusRow(TagSettingsRowStartView)
    press(Key.DirectionCenter)

    // Opens on the current page (Home); one step down is Catalog.
    press(Key.DirectionDown)
    press(Key.DirectionCenter)

    assertEquals(listOf("startView" to "catalog"), api.settingsPatches)
    compose.onNodeWithTag(settingsOptionTag("start", "catalog")).assertDoesNotExist()
  }
}
