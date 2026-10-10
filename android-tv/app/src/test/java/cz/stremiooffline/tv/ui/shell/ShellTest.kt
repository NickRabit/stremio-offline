@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class ShellTest {

  @get:Rule val compose = createComposeRule()

  private fun mount(section: Section = Section.Library) {
    compose.setContent {
      ShellScaffold(
        username = "demo",
        start = section,
        current = section,
        onBackToExit = {},
      ) { requester ->
        Box(
          Modifier
            .fillMaxSize()
            .background(Color.Black)
            .focusRequester(requester)
            .focusable()
            .testTag("content"),
        )
        LaunchedEffect(Unit) { runCatching { requester.requestFocus() } }
      }
    }
  }

  // Bug 3: LEFT right after the shell appears must land on the current section, not another one.
  @Test
  fun `left from content focuses the current section's rail item immediately and later`() {
    mount(Section.Library)
    compose.onNodeWithTag("content").assertIsFocused()

    compose.onNodeWithTag("content").performKeyInput { pressKey(Key.DirectionLeft) }
    compose.onNodeWithTag(railTag(Section.Library)).assertIsFocused()

    compose.onNodeWithTag(railTag(Section.Library)).performKeyInput { pressKey(Key.DirectionRight) }
    compose.mainClock.advanceTimeBy(1_000)
    compose.onNodeWithTag("content").performKeyInput { pressKey(Key.DirectionLeft) }
    compose.onNodeWithTag(railTag(Section.Library)).assertIsFocused()
  }

  @Test
  fun `right from the rail returns to the last focused content`() {
    mount(Section.Library)

    compose.onNodeWithTag("content").performKeyInput { pressKey(Key.DirectionLeft) }
    compose.onNodeWithTag(railTag(Section.Library)).assertIsFocused()
    compose.onNodeWithTag(railTag(Section.Library)).performKeyInput { pressKey(Key.DirectionRight) }
    compose.onNodeWithTag("content").assertIsFocused()
  }
}
