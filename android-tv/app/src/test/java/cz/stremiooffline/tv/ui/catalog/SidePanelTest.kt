@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Side-panel list rows keep their size on focus, so the first and the last row of a long list
 * stay inside the panel instead of being clipped by its scrolling viewport.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class SidePanelTest {

  @get:Rule val compose = createComposeRule()

  private val rowCount = 34

  private fun panelRowTag(index: Int) = "panel_row_$index"

  private fun mount() {
    val first = FocusRequester()
    compose.setContent {
      Box(Modifier.fillMaxSize()) {
        SidePanel(title = "Sources", onClose = {}, initialFocus = first) {
          repeat(rowCount) { index ->
            PanelOption(
              text = "Row $index",
              onClick = {},
              modifier = Modifier
                .testTag(panelRowTag(index))
                .then(if (index == 0) Modifier.focusRequester(first) else Modifier),
            )
          }
        }
      }
    }
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun focused(tag: String): Boolean =
    compose.onAllNodes(isFocused()).fetchSemanticsNodes()
      .any { it.config.getOrElse(SemanticsProperties.TestTag) { "" } == tag }

  private fun assertInsideThePanel(tag: String) {
    compose.onNodeWithTag(tag).assertIsDisplayed()
    val row = compose.onNodeWithTag(tag).getUnclippedBoundsInRoot()
    val list = compose.onNodeWithTag(TagSidePanelList).getUnclippedBoundsInRoot()
    assertTrue("$tag top $row is above the panel list $list", row.top >= list.top)
    assertTrue("$tag bottom $row is below the panel list $list", row.bottom <= list.bottom)
    assertTrue("$tag left $row is left of the panel list $list", row.left >= list.left)
    assertTrue("$tag right $row is right of the panel list $list", row.right <= list.right)
  }

  @Test
  fun `the focused first and last rows stay inside the panel`() {
    mount()
    compose.waitForIdle()

    assertTrue("the panel focuses the first row itself", focused(panelRowTag(0)))
    assertInsideThePanel(panelRowTag(0))

    repeat(rowCount - 1) { press(Key.DirectionDown) }
    assertTrue("the D-pad reaches the last row", focused(panelRowTag(rowCount - 1)))
    assertInsideThePanel(panelRowTag(rowCount - 1))
  }
}
