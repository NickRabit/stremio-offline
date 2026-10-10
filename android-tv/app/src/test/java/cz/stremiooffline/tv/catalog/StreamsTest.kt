package cz.stremiooffline.tv.catalog

import cz.stremiooffline.tv.catalog.Streams.StreamFilters
import cz.stremiooffline.tv.catalog.Streams.StreamSort
import cz.stremiooffline.tv.data.BehaviorHintsDto
import cz.stremiooffline.tv.data.StreamDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** One JVM test per `web/src/streams.test.ts` case that covers a ported function. */
class StreamsTest {

  private fun stream(
    sourceId: String = "source",
    kind: String = "remote",
    playable: Boolean = true,
    name: String? = null,
    title: String? = null,
    description: String? = null,
    addonKey: String? = null,
    addonName: String? = null,
    behaviorHints: BehaviorHintsDto? = null,
  ) = StreamDto(sourceId, kind, playable, name, title, description, addonKey, addonName, behaviorHints)

  private fun names(list: List<StreamDto>): List<String> = list.map { it.name.orEmpty() }

  private fun filters(
    addon: String = "",
    language: String = "",
    sort: StreamSort = StreamSort.Recommended,
  ): StreamFilters = StreamFilters(addon, language, sort)

  @Test
  fun `streamText joins every field an addon may have used`() {
    assertEquals(
      "A B C D.mkv",
      Streams.streamText(stream(name = "A", title = "B", description = "C", behaviorHints = BehaviorHintsDto(filename = "D.mkv"))),
    )
  }

  @Test
  fun `streamText skips fields the addon left out`() {
    assertEquals("A C", Streams.streamText(stream(name = "A", description = "C")))
  }

  @Test
  fun `languages take the bingeGroup when the text says nothing`() {
    assertEquals(listOf("cs"), Streams.streamLanguages(stream(name = "FullHD", behaviorHints = BehaviorHintsDto(bingeGroup = "Webshare|CZ|1080p|"))))
  }

  @Test
  fun `languages merge what the text and the bingeGroup each say`() {
    assertEquals(
      listOf("cs", "sk"),
      Streams.streamLanguages(stream(title = "CZ dabing", behaviorHints = BehaviorHintsDto(bingeGroup = "Webshare|CZ,SK|720p|"))).sorted(),
    )
  }

  @Test
  fun `languages leave a stream without either alone`() {
    assertEquals(emptyList<String>(), Streams.streamLanguages(stream(name = "1080p", behaviorHints = BehaviorHintsDto(bingeGroup = "torrentio|1080p|x264"))))
  }

  @Test
  fun `languages fall back to the title language when the addon left its field blank`() {
    assertEquals(listOf("cs"), Streams.streamLanguages(stream(name = "SD", behaviorHints = BehaviorHintsDto(bingeGroup = "Webshare||480p|")), "cs"))
  }

  @Test
  fun `languages do not put the title language on a torrent listing that says nothing`() {
    assertEquals(emptyList<String>(), Streams.streamLanguages(stream(name = "4K", behaviorHints = BehaviorHintsDto(bingeGroup = "torrentio|4k|x265|HDR")), "cs"))
    assertEquals(emptyList<String>(), Streams.streamLanguages(stream(name = "4K"), "cs"))
  }

  @Test
  fun `languages never override what the addon did say`() {
    assertEquals(listOf("en"), Streams.streamLanguages(stream(name = "FullHD", behaviorHints = BehaviorHintsDto(bingeGroup = "Webshare|EN|1080p|")), "cs"))
  }

  @Test
  fun `size prefers the structured hint`() {
    assertEquals(12345.0, Streams.streamSize(stream(title = "💾 1 GB", behaviorHints = BehaviorHintsDto(videoSize = 12345.0)))!!, 0.0)
  }

  @Test
  fun `size ignores a zero hint and falls back to the text`() {
    assertEquals(500e6, Streams.streamSize(stream(title = "500 MB", behaviorHints = BehaviorHintsDto(videoSize = 0.0)))!!, 0.0)
  }

  @Test
  fun `size parses the units addons actually write`() {
    assertEquals(35_090_000_000.0, Streams.streamSize(stream(title = "💾 35.09 GB"))!!, 0.0)
    assertEquals(700e6, Streams.streamSize(stream(title = "700 MB"))!!, 0.0)
    assertEquals(1.5e12, Streams.streamSize(stream(title = "1.5 TB"))!!, 0.0)
    assertEquals(820e3, Streams.streamSize(stream(title = "820 KB"))!!, 0.0)
  }

  @Test
  fun `size reads the abbreviation Luna writes and not the bitrate beside it`() {
    assertEquals(2.2e9, Streams.streamSize(stream(title = "2 Mb/s · 2:22:00 · 2.2G"))!!, 0.0)
    assertEquals(6.3e9, Streams.streamSize(stream(title = "6 Mb/s · 2:22:33 · 6.3G"))!!, 0.0)
    assertEquals(1.4e12, Streams.streamSize(stream(title = "1.4T"))!!, 0.0)
  }

  @Test
  fun `size does not read a bitrate as a size`() {
    assertNull(Streams.streamSize(stream(title = "2 Mb/s")))
    assertNull(Streams.streamSize(stream(title = "1500 kbps")))
    assertNull(Streams.streamSize(stream(title = "2 Mbit/s")))
  }

  @Test
  fun `size does not read a resolution as a size`() {
    assertNull(Streams.streamSize(stream(title = "Movie 4K HDR")))
    assertNull(Streams.streamSize(stream(title = "The Matrix 2K remaster")))
  }

  @Test
  fun `size accepts a decimal comma`() {
    assertEquals(2.5e9, Streams.streamSize(stream(title = "2,5 GB"))!!, 0.0)
  }

  @Test
  fun `size accepts the unit written straight after the number`() {
    assertEquals(4e9, Streams.streamSize(stream(title = "4GB"))!!, 0.0)
  }

  @Test
  fun `size uses the per-file size after a torrent pack size`() {
    assertEquals(4.01e9, Streams.streamSize(stream(title = "Complete pack 86 GB\nEpisode 4.01 GB"))!!, 0.0)
  }

  @Test
  fun `size is case-insensitive`() {
    assertEquals(3e9, Streams.streamSize(stream(title = "3 gb"))!!, 0.0)
  }

  @Test
  fun `size returns nothing when no size is mentioned`() {
    assertNull(Streams.streamSize(stream(title = "1080p WEB-DL")))
  }

  @Test
  fun `size does not read a unit glued to a longer word`() {
    assertNull(Streams.streamSize(stream(title = "10 GBps link")))
  }

  private val czechSmall = stream(name = "cz-small", title = "Czech 1 GB", addonName = "alpha")
  private val czechBig = stream(name = "cz-big", title = "Czech 8 GB", addonName = "beta")
  private val englishBig = stream(name = "en-big", title = "English 20 GB", addonName = "alpha")
  private val unknown = stream(name = "unknown", title = "1080p", addonName = "beta")
  private val all = listOf(englishBig, czechSmall, unknown, czechBig)

  @Test
  fun `arrangeStreams filters by addon`() {
    assertEquals(listOf("cz-small", "en-big"), names(Streams.arrangeStreams(all, filters(addon = "alpha"), "cs")))
  }

  @Test
  fun `arrangeStreams filters by language`() {
    assertEquals(listOf("cz-big", "cz-small"), names(Streams.arrangeStreams(all, filters(language = "cs"), "cs")).sorted())
  }

  @Test
  fun `arrangeStreams puts the preferred language first then the largest`() {
    assertEquals(listOf("cz-big", "cz-small", "en-big", "unknown"), names(Streams.arrangeStreams(all, filters(), "cs")))
  }

  @Test
  fun `arrangeStreams respects addon priority inside the preferred language`() {
    val priority = mapOf("beta" to 0, "alpha" to 1)
    assertEquals(listOf("cz-big", "cz-small"), names(Streams.arrangeStreams(listOf(czechSmall, czechBig), filters(), "cs", priority)))
    assertEquals(listOf("cz-big", "cz-small"), names(Streams.arrangeStreams(listOf(czechBig, czechSmall), filters(), "en", priority)))
  }

  @Test
  fun `arrangeStreams sorts by size in both directions`() {
    assertEquals(listOf("en-big", "cz-big", "cz-small", "unknown"), names(Streams.arrangeStreams(all, filters(sort = StreamSort.SizeDesc), "cs")))
    assertEquals(listOf("cz-small", "cz-big", "en-big", "unknown"), names(Streams.arrangeStreams(all, filters(sort = StreamSort.SizeAsc), "cs")))
  }

  @Test
  fun `arrangeStreams keeps an unknown size last when sorting ascending`() {
    assertEquals(listOf("cz-small", "unknown"), names(Streams.arrangeStreams(listOf(unknown, czechSmall), filters(sort = StreamSort.SizeAsc), "cs")))
  }

  @Test
  fun `arrangeStreams sorts by addon priority and keeps the addon order inside a group`() {
    val priority = mapOf("beta" to 0, "alpha" to 1)
    assertEquals(listOf("unknown", "cz-big", "en-big", "cz-small"), names(Streams.arrangeStreams(all, filters(sort = StreamSort.Addon), "cs", priority)))
  }

  @Test
  fun `arrangeStreams puts addons with no priority last`() {
    val priority = mapOf("beta" to 0)
    assertEquals(listOf("unknown", "cz-big", "en-big", "cz-small"), names(Streams.arrangeStreams(all, filters(sort = StreamSort.Addon), "cs", priority)))
  }

  @Test
  fun `arrangeStreams leaves the input array untouched`() {
    val input = all.toList()
    Streams.arrangeStreams(input, filters(sort = StreamSort.SizeDesc), "cs")
    assertEquals(all, input)
  }

  private val http = stream(name = "http", playable = true, kind = "remote", title = "Czech 1 GB")
  private val torrent = stream(name = "torrent", playable = false, kind = "torrent", title = "Czech 8 GB")
  private val external = stream(name = "ext", playable = false, kind = "unsupported", title = "Czech 2 GB")

  @Test
  fun `visibleCatalogStreams hides torrents until a debrid token is configured`() {
    assertEquals(listOf("http"), names(Streams.visibleCatalogStreams(listOf(torrent, http), filters(), "cs", emptyMap(), false)))
    assertEquals(listOf("torrent", "http"), names(Streams.visibleCatalogStreams(listOf(torrent, http), filters(), "cs", emptyMap(), true)))
  }

  @Test
  fun `pickDefaultStream prefers a playable HTTP source over a torrent`() {
    assertEquals("http", Streams.pickDefaultStream(listOf(torrent, http))?.name)
    assertEquals("torrent", Streams.pickDefaultStream(listOf(torrent))?.name)
  }

  @Test
  fun `streamBadge labels torrents as RD, not as a generic external source`() {
    assertEquals("HTTP", Streams.streamBadge(http))
    assertEquals("RD", Streams.streamBadge(torrent))
    assertEquals("EXT", Streams.streamBadge(external))
  }

  @Test
  fun `canQueue lets a torrent be queued only when Real-Debrid is configured`() {
    assertEquals(false, Streams.canQueue(torrent, false))
    assertEquals(true, Streams.canQueue(torrent, true))
    assertEquals(true, Streams.canQueue(http, false))
  }

  @Test
  fun `offeredStreams keeps a source the server cannot play out of the list`() {
    val notice = stream(sourceId = "n1", kind = "unsupported", playable = false, name = "⚠ Luna", title = "VIP expires in 4 days.", addonName = "Luna")
    val playable = stream(sourceId = "s1", name = "FullHD")
    assertEquals(listOf("s1"), Streams.offeredStreams(listOf(notice, playable)).map { it.sourceId })
  }

  @Test
  fun `noticeText reads the message from the field the addon used`() {
    val notice = stream(kind = "unsupported", playable = false, name = "⚠ Luna", title = "VIP expires in 4 days.")
    assertEquals("VIP expires in 4 days.", Streams.noticeText(notice))
    assertEquals("Only a name", Streams.noticeText(stream(kind = "unsupported", playable = false, name = "Only a name")))
    assertEquals("Two lines", Streams.noticeText(stream(kind = "unsupported", playable = false, title = "Two\n lines")))
  }

  @Test
  fun `addonNotices shows a message repeated by several addons once`() {
    val notice = stream(sourceId = "n1", kind = "unsupported", playable = false, title = "VIP expires in 4 days.", addonName = "Luna")
    val other = stream(sourceId = "n2", kind = "unsupported", playable = false, title = "VIP expires in 4 days.", addonName = "Luna: Search")
    val playable = stream(sourceId = "s1", name = "FullHD")
    assertEquals(listOf("n1"), Streams.addonNotices(listOf(notice, other, playable)).map { it.sourceId })
  }

  @Test
  fun `addonNotices drops a notice with nothing to say`() {
    assertEquals(emptyList<StreamDto>(), Streams.addonNotices(listOf(stream(kind = "unsupported", playable = false))))
  }

  @Test
  fun `pickDefaultStream never picks a notice as the default source`() {
    val notice = stream(kind = "unsupported", playable = false, name = "⚠ Luna", title = "VIP expires in 4 days.")
    assertNull(Streams.pickDefaultStream(Streams.offeredStreams(listOf(notice))))
  }
}
