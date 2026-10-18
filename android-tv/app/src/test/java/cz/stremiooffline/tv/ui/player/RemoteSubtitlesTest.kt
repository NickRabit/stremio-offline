package cz.stremiooffline.tv.ui.player

import cz.stremiooffline.tv.data.AddonSubtitleDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.detail.PlayTarget
import org.junit.Assert.assertEquals
import org.junit.Test

/** The subtitles a remote version carries itself: the selected one's, never another version's. */
class RemoteSubtitlesTest {

  private fun stream(sourceId: String, vararg subtitles: AddonSubtitleDto) = StreamDto(
    sourceId = sourceId,
    kind = "remote",
    playable = true,
    remoteItem = RemoteItemContext(libraryId = "rlibA", itemId = "iA", mediaSourceId = sourceId, progressKey = "rk"),
    subtitles = subtitles.toList(),
  )

  private fun target(sourceId: String, versions: List<StreamDto> = emptyList(), catalogue: Boolean = false) = PlayTarget(
    key = "rk",
    title = "Heat",
    resume = false,
    sourceId = sourceId,
    subtitleType = if (catalogue) "movie" else null,
    subtitleTarget = if (catalogue) "tt1" else null,
    catalogue = catalogue,
    remoteItem = RemoteItemContext(libraryId = "rlibA", itemId = "iA", mediaSourceId = sourceId, progressKey = "rk"),
    remoteSources = versions,
  )

  @Test
  fun `the selected version's own subtitles are used`() {
    val s1 = stream("ms1", AddonSubtitleDto("sub1", "cs", "server"))
    val s2 = stream("ms2", AddonSubtitleDto("sub2", "en", "server"))
    val subtitles = remoteSelectedSubtitles(target("ms2", listOf(s1, s2)), emptyList())
    assertEquals(listOf("sub2"), subtitles.map { it.subtitleId })
  }

  @Test
  fun `a matched catalogue identity still never borrows the addon subtitles`() {
    val s1 = stream("ms1", AddonSubtitleDto("sub1", "cs", "server"))
    // The catalogue type and id are set, yet the remote version carries none: the answer is empty.
    assertEquals(emptyList<AddonSubtitleDto>(), remoteSelectedSubtitles(target("ms9", listOf(s1), catalogue = true), emptyList()))
  }

  @Test
  fun `the caller's offered sources stand in when the target carries none`() {
    val offered = listOf(stream("ms3", AddonSubtitleDto("sub3")))
    assertEquals(listOf("sub3"), remoteSelectedSubtitles(target("ms3"), offered).map { it.subtitleId })
  }

  @Test
  fun `a non-remote play is left to the account's addon subtitles`() {
    val plain = PlayTarget(key = "k", title = "T", resume = false, sourceId = "x")
    assertEquals(emptyList<AddonSubtitleDto>(), remoteSelectedSubtitles(plain, listOf(stream("ms3", AddonSubtitleDto("sub3")))))
  }
}
