package cz.stremiooffline.tv.ui.catalog

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.ComposeTestRule

/**
 * The tags among [tags] that this screen draws, read left to right: what the one action row every
 * detail shares looks like on screen.
 */
fun ComposeTestRule.actionRowOrder(vararg tags: String): List<String> {
  val matcher = tags.map { hasTestTag(it) }.reduce { left, right -> left or right }
  return onAllNodes(matcher).fetchSemanticsNodes()
    .sortedBy { it.boundsInRoot.left }
    .mapNotNull { it.config.getOrNull(SemanticsProperties.TestTag) }
}
