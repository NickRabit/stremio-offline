@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.BrowseResult
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.settings.TagSettingsRowServer
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Bug: the shell's selected section was a plain `remember`, so the activity recreation a locale
 * change forces dropped the viewer back onto the account's start page instead of Settings.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class SettingsRestoreTest {

  @get:Rule val compose = createComposeRule()

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun isFocusedOn(tag: String): Boolean =
    compose.onAllNodes(isFocused()).fetchSemanticsNodes()
      .any { it.config.getOrElse(SemanticsProperties.TestTag) { "" } == tag }

  @Test
  fun `the section opened on the rail survives the locale recreation`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult("", listOf(BrowseItem.Folder(path = "Films", name = "Films", fileCount = 1)), 1, false)
    val tester = StateRestorationTester(compose)
    tester.setContent { Shell(start = Section.Library, api = api, username = "demo", onSignOut = {}) }
    compose.waitForIdle()

    // The account item of the rail opens Settings.
    press(Key.DirectionLeft)
    var guard = 0
    while (!isFocusedOn(railTag(Section.Account)) && guard++ < 5) press(Key.DirectionDown)
    compose.onNodeWithTag(railTag(Section.Account)).assertIsFocused()
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSettingsRowServer).assertExists()

    // A locale change recreates the activity; the shell has to come back to Settings, not Library.
    tester.emulateSavedInstanceStateRestore()
    compose.waitForIdle()
    compose.onNodeWithTag(TagSettingsRowServer).assertExists()
  }
}
