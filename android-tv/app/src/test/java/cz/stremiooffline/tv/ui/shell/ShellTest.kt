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
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.catalog.OfferedSources
import cz.stremiooffline.tv.ui.detail.PlayTarget
import org.junit.Rule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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

  // A play that started from the catalogue detail keeps the sources the detail keeps reporting,
  // a library copy included; a play the catalogue never started gets none of them.
  @Test
  fun `a catalogue play keeps the reported sources while a library play gets none`() {
    val reported = OfferedSources(streams = listOf(StreamDto(sourceId = "s1", kind = "remote", playable = true)), loading = true)
    val library = PlayTarget(key = "file:Heat.mkv", title = "Heat", resume = true, path = "Filmy/Heat.mkv")
    val catalogueLocal = PlayTarget(key = "file:Filmy/Heat.mkv", title = "Heat", resume = true, path = "Filmy/Heat.mkv", catalogue = true)
    val catalogueAddon = PlayTarget(key = "movie:tt1", title = "Heat", resume = false, sourceId = "s1", catalogue = true)

    val forLibrary = playerSourcesFor(library, reported)
    assertTrue(forLibrary.streams.isEmpty())
    assertFalse(forLibrary.loading)

    val forCatalogueLocal = playerSourcesFor(catalogueLocal, reported)
    assertEquals(reported.streams, forCatalogueLocal.streams)
    assertTrue(forCatalogueLocal.loading)

    val forCatalogueAddon = playerSourcesFor(catalogueAddon, reported)
    assertEquals(reported.streams, forCatalogueAddon.streams)
    assertTrue(forCatalogueAddon.loading)
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
