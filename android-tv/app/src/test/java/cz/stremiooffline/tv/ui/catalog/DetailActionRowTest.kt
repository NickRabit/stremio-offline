@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.runtime.remember
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import cz.stremiooffline.tv.ui.components.FocusButton
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The one action row every detail draws: one order, whatever a detail happens to offer. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class DetailActionRowTest {

  @get:Rule val compose = createComposeRule()

  private val primaryTag = "row_primary"
  private val primaryLabel = "Play"

  private fun action(tag: String, label: String = tag) =
    DetailAction(label = label, icon = null, onClick = {}, tag = tag)

  private val everything = listOf(
    "row_start_over",
    "row_sources",
    "row_to_library",
    "row_favourite",
    "row_unwatched",
    "row_watched",
    "row_extra_a",
    "row_extra_b",
  )

  private fun mount(
    startOver: DetailAction? = action("row_start_over"),
    toLibrary: DetailAction? = action("row_to_library"),
    unwatched: DetailAction? = action("row_unwatched"),
    watched: DetailAction? = action("row_watched"),
    extras: List<DetailAction> = listOf(action("row_extra_a"), action("row_extra_b")),
  ) {
    compose.setContent {
      DetailActionRow(
        primary = { FocusButton(primaryLabel, {}, Modifier.testTag(primaryTag)) },
        startOver = startOver,
        sources = { FocusButton("Sources", {}, Modifier.testTag("row_sources")) },
        toLibrary = toLibrary,
        favourite = DetailAction(
          label = "row_favourite",
          icon = null,
          glyph = "☆",
          onClick = {},
          tag = "row_favourite",
        ),
        unwatched = unwatched,
        watched = watched,
        caption = remember { ActionCaption() },
        extras = extras,
      )
    }
  }

  /** The row's own buttons as the tree draws them: left to right. */
  private fun drawnOrder(): List<String> {
    val tags = listOf(primaryTag) + everything
    val matcher = tags.map { hasTestTag(it) }
      .reduce { left, right -> left or right }
    return compose.onAllNodes(matcher).fetchSemanticsNodes()
      .mapNotNull { it.config.getOrNull(SemanticsProperties.TestTag) }
  }

  @Test
  fun `the row draws every action in the shared order`() {
    mount()

    assertEquals(
      listOf(
        primaryTag,
        "row_start_over",
        "row_sources",
        "row_to_library",
        "row_favourite",
        "row_unwatched",
        "row_watched",
        "row_extra_a",
        "row_extra_b",
      ),
      drawnOrder(),
    )
  }

  @Test
  fun `an action a detail does not offer is not drawn`() {
    mount(startOver = null, unwatched = null, extras = emptyList())

    assertEquals(
      listOf(primaryTag, "row_sources", "row_to_library", "row_favourite", "row_watched"),
      drawnOrder(),
    )
  }

  @Test
  fun `every icon has its name underneath`() {
    mount()

    compose.onNodeWithText("row_watched").assertExists()
    compose.onNodeWithText("row_favourite").assertExists()
    compose.onNodeWithText("row_start_over").assertExists()
  }
}
