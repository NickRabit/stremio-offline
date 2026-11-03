@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.StreamDto
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** DOWN from the chips returns to the list even when the preselected row is scrolled out of view. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class SourcesPanelChipFocusTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private val rows = (0 until 30).map { index ->
    StreamDto(sourceId = "src$index", kind = "remote", playable = true, name = "Row $index", title = "Source $index", addonName = "Addon")
  }

  private val sort = SourceFilterChip(
    key = "sort",
    title = "Sort",
    value = "Recommended",
    selectedKey = "recommended",
    options = listOf(SourceFilterOption("recommended", "Recommended")),
  )

  @Test
  fun `down from a chip lands on the list when the preselected row is far below`() {
    val focus = FocusRequester()
    compose.setContent {
      Box(Modifier.fillMaxSize()) {
        SourcesPanel(
          streams = rows,
          focusIndex = 25,
          onChoose = {},
          onClose = {},
          filters = listOf(sort),
          initialFocus = focus,
        )
      }
    }
    compose.waitForIdle()
    compose.onNodeWithTag(sourceRowTag(25)).assertIsFocused()

    // The viewer climbs back to the top of the list, then up onto the chips.
    repeat(25) { compose.onNodeWithTag(TagSourcesPanel).performKeyInput { pressKey(Key.DirectionUp) } }
    compose.waitForIdle()
    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()
    compose.onNodeWithTag(TagSourcesPanel).performKeyInput { pressKey(Key.DirectionUp) }
    compose.waitForIdle()
    compose.onNodeWithTag(sourceFilterTag("sort")).assertIsFocused()

    compose.onNodeWithTag(TagSourcesPanel).performKeyInput { pressKey(Key.DirectionDown) }
    compose.waitForIdle()
    compose.onNodeWithTag(sourceFilterTag("sort")).assertIsNotFocused()
    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()
  }
}
