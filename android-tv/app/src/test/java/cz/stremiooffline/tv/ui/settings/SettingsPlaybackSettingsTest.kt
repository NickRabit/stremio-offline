@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.settings

import androidx.activity.ComponentActivity
import androidx.compose.runtime.remember
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsFocused
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
}
