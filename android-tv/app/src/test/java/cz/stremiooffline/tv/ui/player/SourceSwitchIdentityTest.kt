package cz.stremiooffline.tv.ui.player

import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.detail.PlayTarget
import org.junit.Assert.assertEquals
import org.junit.Test

class SourceSwitchIdentityTest {
  private val origin = RemoteItemContext("library-a", "movie-a", "v1", "remote:a")

  @Test
  fun `equal raw version ids from different libraries never share a timestamp`() {
    assertEquals(0.0, sourceSwitchPosition(origin, origin.copy(libraryId = "library-b"), 83.0), 0.0)
    assertEquals(0.0, sourceSwitchPosition(origin, origin.copy(itemId = "movie-b"), 83.0), 0.0)
    assertEquals(0.0, sourceSwitchPosition(origin, origin.copy(mediaSourceId = "v2"), 83.0), 0.0)
    assertEquals(83.0, sourceSwitchPosition(origin, origin.copy(), 83.0), 0.0)
  }

  @Test
  fun `entering remote playback from a nonremote source starts that version independently`() {
    assertEquals(0.0, sourceSwitchPosition(null, origin, 83.0), 0.0)
    assertEquals(83.0, sourceSwitchPosition(origin, null, 83.0), 0.0)
  }

  @Test
  fun `catalogue owner survives a local copy between two addon plays`() {
    val title = PlayTarget(
      key = "movie:tt1", title = "Heat", resume = true, sourceId = "addon-a",
      addonKey = "cinemeta", subtitleType = "movie", subtitleTarget = "tt1", catalogue = true,
    )
    val local = switchedTarget(title, StreamDto(kind = "library", playable = true, localPath = "films/Heat.mkv"))
    val incoming = switchedTarget(local, StreamDto(kind = "remote", playable = true, sourceId = "addon-b", addonKey = "provider-b"))
    assertEquals("file:films/Heat.mkv", local.key)
    assertEquals("cinemeta", local.addonKey)
    assertEquals("movie:tt1", incoming.key)
    assertEquals("cinemeta", incoming.addonKey)
  }
}
