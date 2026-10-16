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
    assertEquals(0.0, sourceSwitchPosition(origin, origin.copy(libraryId = "library-b"), origin.progressKey, 83.0), 0.0)
    assertEquals(0.0, sourceSwitchPosition(origin, origin.copy(itemId = "movie-b"), origin.progressKey, 83.0), 0.0)
    assertEquals(0.0, sourceSwitchPosition(origin, origin.copy(mediaSourceId = "v2"), origin.progressKey, 83.0), 0.0)
    assertEquals(83.0, sourceSwitchPosition(origin, origin.copy(), origin.progressKey, 83.0), 0.0)
  }

  @Test
  fun `entering remote playback from a nonremote source starts that version independently`() {
    assertEquals(0.0, sourceSwitchPosition(null, origin, origin.progressKey, 83.0), 0.0)
    assertEquals(83.0, sourceSwitchPosition(origin, null, origin.progressKey, 83.0), 0.0)
  }

  @Test
  fun `two versions of one named title carry the position between them`() {
    val other = RemoteItemContext("library-b", "movie-b", "v2", "remote:b")
    // One title, one position: the key the switch is being made under, not the two items' ids,
    // is what decides it.
    assertEquals(83.0, sourceSwitchPosition(origin, other, "movie:tt0133093", 83.0), 0.0)
    // A key that names an item keeps today's rule, so another item's version starts at the top.
    assertEquals(0.0, sourceSwitchPosition(origin, other, "remote:library-a:movie-a", 83.0), 0.0)
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
