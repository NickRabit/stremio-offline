package cz.stremiooffline.tv.ui

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class OfflinePanelTest {

  @get:Rule val compose = createComposeRule()

  @Test
  fun `the lost server screen opens with Try again focused so the first press acts`() {
    var retries = 0
    var changes = 0
    compose.setContent {
      OfflinePanel(server = "http://10.0.2.2:8090", onRetry = { retries++ }, onChangeServer = { changes++ })
    }
    compose.waitForIdle()

    compose.onNodeWithText("Try again").assertIsFocused()
    compose.onNodeWithText("Try again").performKeyInput { pressKey(Key.DirectionRight) }
    compose.waitForIdle()
    compose.onNodeWithText("Change server").assertIsFocused()
    compose.onNodeWithText("Change server").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    assertEquals(1, changes)
    assertEquals(0, retries)
  }
}
