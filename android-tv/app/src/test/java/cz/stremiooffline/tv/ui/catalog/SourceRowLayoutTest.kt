@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.StreamDto
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "cs-rCZ-w960dp-h540dp-xhdpi")
class SourceRowLayoutTest {

  @get:Rule val compose = createComposeRule()

  @Test
  fun `every source kind starts its title at one badge-column edge`() {
    val streams = listOf(
      StreamDto(sourceId = "local", kind = "library", playable = true, localPath = "Heat.mkv", libraryName = "Local origin"),
      StreamDto(
        sourceId = "remote",
        kind = "remote",
        playable = true,
        remoteItem = RemoteItemContext("rlib", "item", "source", "remote:rlib:item"),
        provider = "Jellyfin",
        libraryName = "Remote origin",
      ),
      StreamDto(sourceId = "http", kind = "http", playable = true, addonName = "HTTP addon"),
      StreamDto(sourceId = "rd", kind = "torrent", playable = false, addonName = "Debrid addon"),
    )
    compose.setContent {
      SourcesPanel(streams = streams, focusIndex = 0, onChoose = {}, onClose = {})
    }
    compose.waitForIdle()

    compose.onNodeWithText("Vzdálené").assertIsDisplayed()
    val starts = listOf("Local origin", "Jellyfin · Remote origin", "HTTP addon", "Debrid addon")
      .map { compose.onNodeWithText(it).getBoundsInRoot().left }

    starts.zipWithNext().forEach { (left, right) -> assertEquals(left.value, right.value, 0.5f) }
  }
}
