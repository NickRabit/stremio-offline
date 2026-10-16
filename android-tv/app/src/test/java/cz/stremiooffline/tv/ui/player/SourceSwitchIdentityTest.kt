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

  @Test
  fun `every kind of switch carries the row's own stable handle`() {
    val current = PlayTarget(
      key = "movie:tt1", title = "Heat", resume = true, sourceId = "addon-a", remoteItem = origin,
      subtitleType = "movie", subtitleTarget = "tt1", catalogue = true,
    )
    val addon = StreamDto(kind = "remote", playable = true, sourceId = "addon-b", stableKey = "a:${"1".repeat(24)}")
    val file = StreamDto(kind = "library", playable = true, localPath = "films/Heat.mkv", stableKey = "f:${"2".repeat(24)}")
    val version = StreamDto(
      kind = "remote", playable = true, sourceId = "ms2", stableKey = "m:${"3".repeat(24)}",
      remoteItem = origin.copy(mediaSourceId = "v2"),
    )

    assertEquals(addon.stableKey, switchedTarget(current, addon).stableKey)
    assertEquals(file.stableKey, switchedTarget(current, file).stableKey)
    assertEquals(version.stableKey, switchedTarget(current, version).stableKey)
  }

  @Test
  fun `the panel lists the row that is playing first`() {
    val first = StreamDto(sourceId = "a", kind = "remote", playable = true)
    val playing = StreamDto(sourceId = "b", kind = "remote", playable = true)
    val last = StreamDto(sourceId = "c", kind = "remote", playable = true)
    val rows = listOf(first, playing, last)

    assertEquals(listOf("b", "a", "c"), sourcesWithPlayingFirst(rows, playing).map { it.sourceId })
    // Nothing playing, and a row the list does not hold, both leave the order alone.
    assertEquals(listOf("a", "b", "c"), sourcesWithPlayingFirst(rows, null).map { it.sourceId })
    assertEquals(listOf("a", "b", "c"), sourcesWithPlayingFirst(rows, StreamDto(sourceId = "z")).map { it.sourceId })
  }
}
