@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The field must show where the remote is before anyone starts typing. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class TvTextFieldTest {

  @get:Rule val compose = createComposeRule()

  private fun active(value: Boolean) = SemanticsMatcher.expectValue(TvFieldActive, value)

  @Test
  fun `a field reached with the D-pad draws its focus border without editing`() {
    compose.setContent {
      val first = remember { FocusRequester() }
      var a by remember { mutableStateOf("") }
      var b by remember { mutableStateOf("") }
      Column {
        TvTextField(label = "A", value = a, onValueChange = { a = it }, surfaceRequester = first, testTag = "a")
        TvTextField(label = "B", value = b, onValueChange = { b = it }, testTag = "b")
      }
      LaunchedEffect(Unit) { first.requestFocus() }
    }
    compose.waitForIdle()
    compose.onNodeWithTag("a").assertIsFocused().assert(active(true))
    compose.onNodeWithTag("b").assert(active(false))

    compose.onRoot().performKeyInput { pressKey(Key.DirectionDown) }
    compose.waitForIdle()

    compose.onNodeWithTag("b").assertIsFocused().assert(active(true))
    compose.onNodeWithTag("a").assert(active(false))
  }
}
