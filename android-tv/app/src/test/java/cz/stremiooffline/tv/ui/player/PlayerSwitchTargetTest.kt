package cz.stremiooffline.tv.ui.player

import cz.stremiooffline.tv.data.BehaviorHintsDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.detail.PlayTarget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The target a switch inside the player builds: each incoming row keeps its own identity, a generic
 * addon row keeps the title's own key and never the key of the file or remote version it was
 * reached from, and the snapshot a native detail handed over travels with every one of them.
 */
class PlayerSwitchTargetTest {

  private val nativeItem = RemoteItemContext(
    libraryId = "rlibA",
    itemId = "iA",
    mediaSourceId = "ms1",
    progressKey = "remote:rlibA:iA",
  )

  private fun nativeVersion(sourceId: String, item: RemoteItemContext = nativeItem) = StreamDto(
    sourceId = sourceId,
    kind = "remote",
    playable = true,
    name = "Version $sourceId",
    remoteItem = item.copy(mediaSourceId = sourceId),
  )

  private val addonRow = StreamDto(
    sourceId = "srcA",
    kind = "remote",
    playable = true,
    addonKey = "alpha",
    addonName = "Alpha",
  )

  private val localRow = StreamDto(
    sourceId = "",
    kind = "library",
    playable = true,
    localPath = "Filmy/Heat.mkv",
    libraryName = "Filmy",
    behaviorHints = BehaviorHintsDto(filename = "Heat.mkv"),
  )

  /** A native detail's play: the item's own row, with the whole loaded list as its snapshot. */
  private fun nativePlay(snapshot: List<StreamDto>): PlayTarget = PlayTarget(
    key = "remote:rlibA:iA",
    title = "Heat",
    resume = true,
    sourceId = "ms1",
    subtitleType = "movie",
    subtitleTarget = "tt1",
    remoteItem = nativeItem,
    remoteSources = listOf(nativeVersion("ms1")),
    initialSources = snapshot,
  )

  @Test
  fun `a switch to an addon row keeps the title's generic key and subtitles`() {
    val snapshot = listOf(nativeVersion("ms1"), addonRow)
    val target = switchedTarget(nativePlay(snapshot), addonRow)

    // The generic identity the addon rows were loaded under, never the native item's own key and
    // never the row's opaque source id.
    assertEquals("movie:tt1", target.key)
    assertEquals("tt1", target.subtitleTarget)
    assertEquals("movie", target.subtitleType)
    assertEquals("srcA", target.sourceId)
    assertNull(target.remoteItem)
    assertNull(target.path)
    assertEquals(snapshot, target.initialSources)
  }

  @Test
  fun `a switch to another media library keeps that item's own identity`() {
    val foreignItem = RemoteItemContext("rlibB", "iB", "ms9", "remote:rlibB:iB")
    val foreign = nativeVersion("ms9", foreignItem)
    val snapshot = listOf(nativeVersion("ms1"), foreign, addonRow)

    val target = switchedTarget(nativePlay(snapshot), foreign)

    assertEquals("remote:rlibB:iB", target.key)
    assertEquals("rlibB", target.remoteItem?.libraryId)
    assertEquals("iB", target.remoteItem?.itemId)
    assertEquals("ms9", target.sourceId)
    // Only that item's own versions: the native item's list is never lent to it.
    assertEquals(listOf("ms9"), target.remoteSources.map { it.sourceId })
    assertEquals(snapshot, target.initialSources)
  }

  @Test
  fun `a switch to a library copy plays the file's own key`() {
    val snapshot = listOf(nativeVersion("ms1"), localRow, addonRow)
    val target = switchedTarget(nativePlay(snapshot), localRow)

    assertEquals("file:Filmy/Heat.mkv", target.key)
    assertEquals("Filmy/Heat.mkv", target.path)
    assertEquals("Heat.mkv", target.title)
    assertNull(target.remoteItem)
    assertEquals(snapshot, target.initialSources)
  }

  @Test
  fun `a switch out of a library copy keeps the title's generic identity when one is in hand`() {
    // The library play a native detail started: the file's own key, the title's generic identity.
    val fromLocal = PlayTarget(
      key = "file:Filmy/Heat.mkv",
      title = "Heat",
      resume = false,
      path = "Filmy/Heat.mkv",
      subtitleType = "movie",
      subtitleTarget = "tt1",
      initialSources = listOf(localRow, addonRow),
    )
    val target = switchedTarget(fromLocal, addonRow)

    assertEquals("movie:tt1", target.key)
    assertEquals("srcA", target.sourceId)
    assertEquals(listOf(localRow, addonRow), target.initialSources)
  }

  @Test
  fun `a library play that knows no generic identity keeps the file's own key`() {
    // The old filesystem flow: a play the library view started has no catalogue identity at all.
    val fromLibrary = PlayTarget(key = "file:Filmy/Heat.mkv", title = "Heat", resume = false, path = "Filmy/Heat.mkv")
    val target = switchedTarget(fromLibrary, addonRow)

    assertEquals("file:Filmy/Heat.mkv", target.key)
    assertEquals("srcA", target.sourceId)
  }

  @Test
  fun `a catalogue play keeps its exact catalogue key and subtitles`() {
    val fromCatalogue = PlayTarget(
      key = "movie:tt1",
      title = "It",
      resume = true,
      sourceId = "srcA",
      catalogue = true,
      subtitleType = "movie",
      subtitleTarget = "tt1",
      initialSources = null,
    )
    val target = switchedTarget(fromCatalogue, StreamDto(sourceId = "srcB", kind = "remote", playable = true))

    assertEquals("movie:tt1", target.key)
    assertEquals("srcB", target.sourceId)
    assertEquals("movie", target.subtitleType)
    assertEquals("tt1", target.subtitleTarget)
    assertTrue(target.catalogue)
    assertNull(target.initialSources)
  }

  @Test
  fun `the title's own addon owner travels and never the row's provider`() {
    val fromCatalogue = PlayTarget(
      key = "movie:tt1",
      title = "It",
      resume = true,
      addonKey = "cinemeta",
      catalogue = true,
      subtitleType = "movie",
      subtitleTarget = "tt1",
    )
    val target = switchedTarget(fromCatalogue, addonRow)

    assertEquals("cinemeta", target.addonKey)
  }
}
