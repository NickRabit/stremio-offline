@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.settings

import androidx.activity.ComponentActivity
import androidx.compose.runtime.remember
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.requestFocus
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.ui.FakeTvApi
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class SettingsPlaybackSettingsTest {
  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private fun mount(api: FakeTvApi) {
    compose.setContent {
      SettingsRoute(
        api = api,
        username = "demo",
        focusRequester = remember { FocusRequester() },
        onSignOut = {},
        onLocale = {},
      )
    }
    compose.waitForIdle()
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  @Test
  fun `one minute before the end is saved as sec60`() {
    val api = FakeTvApi().apply {
      settingsValue = SettingsResponse(upNextAt = "end")
    }
    mount(api)
    compose.onNodeWithTag(TagSettingsRowUpNext).requestFocus()
    press(Key.DirectionCenter)
    listOf("end", "pct97", "pct98", "pct99", "sec30", "sec60", "sec120", "sec180").forEach {
      compose.onNodeWithTag(settingsOptionTag("upNext", it)).assertExists()
    }
    compose.onNodeWithTag(settingsOptionTag("upNext", "end")).assertIsFocused()

    repeat(5) { press(Key.DirectionDown) }
    compose.onNodeWithTag(settingsOptionTag("upNext", "sec60")).assertIsFocused()
    press(Key.DirectionCenter)

    assertEquals(listOf("upNextAt" to "sec60"), api.settingsPatches)
    compose.onNodeWithTag(TagSettingsRowUpNext).assertIsFocused()
  }

  @Test
  fun `the automatic skip toggle writes a JSON boolean`() {
    val api = FakeTvApi()
    mount(api)
    compose.onNodeWithTag(TagSettingsRowSkipSegments).requestFocus()

    press(Key.DirectionCenter)

    assertEquals(listOf("skipSegmentsAuto" to true), api.settingFlagPatches)
  }

  @Test
  fun `a switch shows its value in the same column as a choice, beside its label`() {
    mount(FakeTvApi().apply { settingsValue = SettingsResponse(upNextAt = "end") })
    val choice = compose.onNode(hasText("When the episode ends") and hasAnyAncestor(hasTestTag(TagSettingsRowUpNext)), useUnmergedTree = true)
      .getBoundsInRoot()
    val switchValue = compose.onNode(hasText("Off") and hasAnyAncestor(hasTestTag(TagSettingsRowSkipSegments)), useUnmergedTree = true)
      .getBoundsInRoot()
    val switchLabel = compose.onNode(hasText("Skip intro and recap automatically") and hasAnyAncestor(hasTestTag(TagSettingsRowSkipSegments)), useUnmergedTree = true)
      .getBoundsInRoot()

    assertEquals(choice.left.value, switchValue.left.value, 0.5f)
    // No empty note line pushes the label above the value it belongs to.
    assertEquals((switchLabel.top.value + switchLabel.bottom.value) / 2, (switchValue.top.value + switchValue.bottom.value) / 2, 1.5f)
  }
}
