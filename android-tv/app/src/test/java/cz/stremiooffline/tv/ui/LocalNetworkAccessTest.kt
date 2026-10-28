package cz.stremiooffline.tv.ui

import android.content.pm.PackageManager
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class LocalNetworkAccessTest {

  @get:Rule val compose = createComposeRule()

  @Test
  fun `older Android versions need no local network permission`() {
    assertTrue(localNetworkAccessGranted(36) { PackageManager.PERMISSION_DENIED })
  }

  @Test
  fun `Android 17 waits for the local network permission`() {
    assertFalse(localNetworkAccessGranted(37) { PackageManager.PERMISSION_DENIED })
    assertTrue(localNetworkAccessGranted(37) { PackageManager.PERMISSION_GRANTED })
  }

  @Test
  fun `the permission screen explains a denial and offers both recovery paths`() {
    var allowed = 0
    var settings = 0
    compose.setContent {
      LocalNetworkPermissionScreen(
        denied = true,
        onAllow = { allowed++ },
        onSettings = { settings++ },
      )
    }

    compose.onNodeWithText("Local network access is off", substring = true).assertIsDisplayed()
    compose.onNodeWithTag(TagLocalNetworkAllow).assertIsFocused().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.onNodeWithTag(TagLocalNetworkAllow).performKeyInput { pressKey(Key.DirectionDown) }
    compose.onNodeWithTag(TagLocalNetworkSettings).performKeyInput {
      pressKey(Key.DirectionCenter)
    }

    assertEquals(1, allowed)
    assertEquals(1, settings)
  }
}
