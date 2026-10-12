@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.settings

import android.content.Context
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
import androidx.compose.ui.test.assertIsDisplayed
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
import cz.stremiooffline.tv.data.RecentSearchDto
import cz.stremiooffline.tv.data.SearchStateDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.TvPreferences
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

  private fun preferences(): TvPreferences =
    TvPreferences(ApplicationProvider.getApplicationContext<Context>())

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
    // The Home row, then the switch, then Send diagnostics: the device facts between and under
    // them are not focusable.
    press(Key.DirectionDown)
    focusRow(TagSettingsRowHomeLayout)
    press(Key.DirectionDown)
    focusRow(TagSettingsRowPreferConversion)
    press(Key.DirectionDown)
    focusRow(TagSettingsRowDiagnostics)
    press(Key.DirectionDown)
    focusRow(TagSettingsRowDiagnostics)
  }

  @Test
  fun `every row is reachable and the last one sits fully in the viewport`() {
    mount(fake())
    val root = compose.onRoot().fetchSemanticsNode()
    val rows = listOf(
      TagSettingsRowServer, TagSettingsRowAccount, TagSettingsRowUiLanguage, TagSettingsRowAudio,
      TagSettingsRowSubtitle, TagSettingsRowStartView, TagSettingsRowHomeLayout,
      TagSettingsRowPreferConversion, TagSettingsRowDiagnostics,
    )
    rows.forEachIndexed { index, tag ->
      if (index > 0) press(Key.DirectionDown)
      focusRow(tag)
    }

    compose.onNodeWithTag(TagSettingsRowDiagnostics).assertIsDisplayed()
    val bounds = compose.onNodeWithTag(TagSettingsRowDiagnostics).fetchSemanticsNode().boundsInRoot
    assertTrue(
      "Send diagnostics is outside the viewport: $bounds of ${root.size.height}px",
      bounds.top >= 0f && bounds.bottom <= root.size.height.toFloat(),
    )
    // The row's own note has to come with it; the row is focused whole, not just its label.
    compose.onNodeWithText(
      ApplicationProvider.getApplicationContext<Context>().getString(R.string.tv_send_diagnostics_note),
      useUnmergedTree = true,
    ).assertIsDisplayed()
  }

  @Test
  fun `the prefer conversion row sits between the start page and the device`() {
    mount(fake())
    repeat(5) { press(Key.DirectionDown) }
    focusRow(TagSettingsRowStartView)
    press(Key.DirectionDown)
    focusRow(TagSettingsRowHomeLayout)
    press(Key.DirectionDown)
    focusRow(TagSettingsRowPreferConversion)

    val notFocusable = SemanticsMatcher.keyNotDefined(SemanticsProperties.Focused)
    compose.onNodeWithTag(TagSettingsRowDevice).assertExists().assert(notFocusable)

    press(Key.DirectionUp)
    focusRow(TagSettingsRowHomeLayout)
    press(Key.DirectionUp)
    focusRow(TagSettingsRowStartView)
  }

  @Test
  fun `OK on the prefer conversion row flips it and stores it on the device`() {
    preferences().preferConversion = false
    mount(fake())
    repeat(7) { press(Key.DirectionDown) }
    focusRow(TagSettingsRowPreferConversion)
    compose.onNodeWithTag(TagSettingsRowPreferConversion).assertTextContains("Off", substring = true)

    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagSettingsRowPreferConversion).assertTextContains("On", substring = true)
    assertTrue(preferences().preferConversion)
  }

  @Test
  fun `toggling the prefer conversion row writes nothing to the server`() {
    val api = fake()
    mount(api)
    repeat(7) { press(Key.DirectionDown) }
    focusRow(TagSettingsRowPreferConversion)

    press(Key.DirectionCenter)

    assertTrue(api.settingsPatches.isEmpty())
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
  fun `the clear history row opens the confirm panel and only confirm clears`() {
    val api = fake()
    api.searchStateValue = SearchStateDto(recent = listOf(RecentSearchDto("Heat", "now")))
    mount(api)
    repeat(7) { press(Key.DirectionDown) }
    focusRow(TagSettingsRowClearHistory)

    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSettingsClearHistoryCancel).assertExists()
    compose.onNodeWithTag(TagSettingsClearHistoryConfirm).assertExists()
    assertEquals(0, api.clearHistoryCalls)

    // Cancel closes the panel and clears nothing.
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSettingsPanel).assertDoesNotExist()
    assertEquals(0, api.clearHistoryCalls)
    focusRow(TagSettingsRowClearHistory)

    // Reopening and stepping to the confirm button clears the history.
    press(Key.DirectionCenter)
    press(Key.DirectionRight)
    press(Key.DirectionCenter)
    assertEquals(1, api.clearHistoryCalls)
  }

  @Test
  fun `the clear history row is hidden when nothing is kept`() {
    mount(fake())
    compose.onNodeWithTag(TagSettingsRowClearHistory).assertDoesNotExist()
  }

  @Test
  fun `the clear history row is hidden while the account saves no history`() {
    val api = fake()
    api.searchStateValue = SearchStateDto(saveHistory = false, recent = listOf(RecentSearchDto("Heat", "now")))
    mount(api)
    compose.onNodeWithTag(TagSettingsRowClearHistory).assertDoesNotExist()
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

  @Test
  fun `the start page panel opens on the fallback when the setting is unknown`() {
    val api = FakeTvApi().apply { settingsValue = SettingsResponse(startView = "following") }
    mount(api)
    repeat(5) { press(Key.DirectionDown) }
    focusRow(TagSettingsRowStartView)
    press(Key.DirectionCenter)

    // The server would answer the catalog for an unknown value, so that is where the panel opens.
    compose.onNodeWithTag(settingsOptionTag("start", "catalog")).assertIsFocused()
    press(Key.DirectionCenter)
    assertEquals(listOf("startView" to "catalog"), api.settingsPatches)
  }

  @Test
  fun `the version row names the app and the server`() {
    val api = fake()
    mount(api)
    // The bare join read "0.5.36 · 0.5.36"; the row now says which number is which.
    compose.onNodeWithText("server ${api.serverVersionValue}", substring = true).assertExists()
  }

  @Test
  fun `a write that fails puts the row back and shows the error line`() {
    val api = fake()
    api.settingsFailure = ApiFailure.Forbidden
    mount(api)
    repeat(3) { press(Key.DirectionDown) }
    press(Key.DirectionCenter)
    press(Key.DirectionDown)
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagSettingsError).assertExists()
    // The row keeps the language the server still has instead of the one that did not stick.
    compose.onNodeWithTag(TagSettingsRowAudio).assertTextContains("English")
  }

  @Test
  fun `OK on Send diagnostics posts the buffer and shows the returned id`() {
    val api = fake()
    cz.stremiooffline.tv.diagnostics.AppLog.clear()
    cz.stremiooffline.tv.diagnostics.AppLog.record("WARN", "API GET /api/home", mapOf("status" to "403"))
    mount(api)
    repeat(8) { press(Key.DirectionDown) }
    focusRow(TagSettingsRowDiagnostics)

    press(Key.DirectionCenter)
    compose.waitForIdle()

    compose.onNodeWithTag(TagSettingsRowDiagnostics).assertTextContains("Sent · b1", substring = true)
    val bundle = api.bundles.single()
    assertEquals("tv", bundle.client)
    assertTrue(bundle.lines.any { it.message == "API GET /api/home" })
  }

  /** The server may explain why it refused the bundle; that explanation is what the row says. */
  @Test
  fun `a failed Send diagnostics shows the server's own error`() {
    val api = fake()
    api.bundleFailure = ApiFailure.Forbidden
    api.bundleFailureMessage = "Client logs are turned off on this server."
    mount(api)
    repeat(8) { press(Key.DirectionDown) }
    focusRow(TagSettingsRowDiagnostics)

    press(Key.DirectionCenter)
    compose.waitForIdle()

    compose.onNodeWithTag(TagSettingsRowDiagnostics).assertTextContains("Client logs are turned off on this server.", substring = true)
  }

  /** Without an explanation the row still names the failure instead of a fixed line. */
  @Test
  fun `a failed Send diagnostics with no explanation names the failure`() {
    val api = fake()
    api.bundleFailure = ApiFailure.Unreachable
    mount(api)
    repeat(8) { press(Key.DirectionDown) }
    focusRow(TagSettingsRowDiagnostics)

    press(Key.DirectionCenter)
    compose.waitForIdle()

    val unreachable = ApplicationProvider.getApplicationContext<Context>()
      .getString(cz.stremiooffline.tv.R.string.tv_err_unreachable)
    compose.onNodeWithTag(TagSettingsRowDiagnostics).assertTextContains(unreachable, substring = true)
  }
}
