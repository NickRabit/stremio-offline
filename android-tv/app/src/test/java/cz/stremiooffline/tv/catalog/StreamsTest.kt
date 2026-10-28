package cz.stremiooffline.tv.catalog

import cz.stremiooffline.tv.catalog.Streams.StreamFilters
import cz.stremiooffline.tv.catalog.Streams.StreamSort
import cz.stremiooffline.tv.data.BehaviorHintsDto
import cz.stremiooffline.tv.data.RemoteCapabilitiesDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.SourceRuleVerdictDto
import cz.stremiooffline.tv.data.StreamDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
    localPath: String? = null,
    libraryName: String? = null,
    stableKey: String? = null,
    rule: SourceRuleVerdictDto? = null,
    rules: Map<String, SourceRuleVerdictDto> = emptyMap(),
  ) = StreamDto(
    sourceId = sourceId,
    kind = kind,
    playable = playable,
    name = name,
    title = title,
    description = description,
    addonKey = addonKey,
    addonName = addonName,
    behaviorHints = behaviorHints,
    localPath = localPath,
    libraryName = libraryName,
    stableKey = stableKey,
    rules = if (rule == null) rules else rules + (rule.profileId to rule),
  )

  private fun verdict(
    status: String,
    rank: List<Double>,
    reasons: List<String> = emptyList(),
    profileId: String = "p1",
  ) = SourceRuleVerdictDto(profileId = profileId, status = status, reasons = reasons, rank = rank)

  private fun names(list: List<StreamDto>): List<String> = list.map { it.name.orEmpty() }

  private fun filters(
    addon: String = "",
    language: String = "",
    sort: StreamSort = StreamSort.FirstRule,
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
  fun `pickDefaultStream opens on the source the viewer last played`() {
    val first = stream(name = "first", playable = true, stableKey = "a:${"1".repeat(24)}")
    val stored = stream(name = "stored", playable = true, stableKey = "a:${"2".repeat(24)}")
    val rows = listOf(first, stored)

    assertEquals("stored", Streams.pickDefaultStream(rows, preferredStableKey = stored.stableKey)?.name)
    // A handle no row carries falls back to today's rule.
    assertEquals("first", Streams.pickDefaultStream(rows, preferredStableKey = "a:${"9".repeat(24)}")?.name)
    assertEquals("first", Streams.pickDefaultStream(rows)?.name)
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
  fun `canQueue queues a remote original only when the server proved the copy right`() {
    val context = RemoteItemContext("rlib_a", "i1", "m1", "k")
    val granted = StreamDto(
      sourceId = "r1", kind = "remote", playable = true, name = "1080p",
      capabilities = RemoteCapabilitiesDto(downloadToLibrary = true), remoteItem = context,
    )
    val denied = granted.copy(sourceId = "r2", capabilities = RemoteCapabilitiesDto(downloadToLibrary = false))
    val bare = granted.copy(sourceId = "r3", capabilities = null)
    assertEquals(true, Streams.canQueue(granted, false))
    assertEquals(false, Streams.canQueue(denied, false))
    assertEquals(false, Streams.canQueue(bare, false))
    // The native right is never enough on its own: a version the server cannot play copies nothing.
    assertEquals(false, Streams.canQueue(granted.copy(playable = false), false))
  }

  @Test
  fun `offeredStreams keeps a source the server cannot play out of the list`() {
    val notice = stream(sourceId = "n1", kind = "unsupported", playable = false, name = "⚠ Luna", title = "VIP expires in 4 days.", addonName = "Luna")
    val playable = stream(sourceId = "s1", name = "FullHD")
    assertEquals(listOf("s1"), Streams.offeredStreams(listOf(notice, playable)).map { it.sourceId })
  }

  // The server hashes an identical stream to one id, so an addon that answers the same source
  // twice hands the panel two rows with one id. Compose refuses duplicate lazy keys at measure
  // time, which is the crash the panel keys were meant to prevent.
  @Test
  fun `offeredStreams drops a source the addon sent twice`() {
    val twice = stream(sourceId = "s1", name = "FullHD", title = "Czech 1 GB", addonName = "alpha")
    assertEquals(listOf("s1"), Streams.offeredStreams(listOf(twice, twice)).map { it.sourceId })
    val lists = Streams.sourceLists(listOf(twice, twice), emptyList(), filters(sort = StreamSort.FirstRule), "cs", true, null)
    assertEquals(1, lists.offered.size)
    assertEquals(1, lists.visible.size)
  }

  @Test
  fun `sourceLists filters the visible list by addon and language`() {
    val all = listOf(
      stream(sourceId = "a1", name = "Czech 1 GB", addonName = "Alpha"),
      stream(sourceId = "b1", name = "English 8 GB", addonName = "Beta"),
    )
    assertEquals(listOf("a1"), Streams.sourceLists(all, emptyList(), filters(addon = "Alpha"), "en", true, null).visible.map { it.sourceId })
    assertEquals(listOf("b1"), Streams.sourceLists(all, emptyList(), filters(language = "en"), "en", true, null).visible.map { it.sourceId })
  }

  @Test
  fun `filterOptions orders addons by priority and then by how many streams they offered`() {
    val all = listOf(
      stream(sourceId = "a1", name = "A one", addonName = "Alpha"),
      stream(sourceId = "b1", name = "B one", addonName = "Beta"),
      stream(sourceId = "a2", name = "A two", addonName = "Alpha"),
      stream(sourceId = "g1", name = "G one", addonName = "Gamma"),
    )
    val options = Streams.filterOptions(all, filters(), mapOf("Beta" to 0, "Alpha" to 1))
    assertEquals(listOf("Beta", "Alpha", "Gamma"), options.addons.map { it.value })
    assertEquals(listOf(1, 2, 1), options.addons.map { it.count })
  }

  @Test
  fun `filterOptions counts a language once per stream that carries it`() {
    val all = listOf(
      stream(sourceId = "a1", name = "Czech 1 GB", addonName = "Alpha"),
      stream(sourceId = "b1", name = "Czech 8 GB", addonName = "Beta"),
      stream(sourceId = "b2", name = "English 2 GB", addonName = "Beta"),
    )
    val options = Streams.filterOptions(all, filters())
    assertEquals(listOf("cs", "en"), options.languages.map { it.value })
    assertEquals(listOf(2, 1), options.languages.map { it.count })
  }

  @Test
  fun `filterOptions counts each menu against what passes the other`() {
    val all = listOf(
      stream(sourceId = "a1", name = "Czech 1 GB", addonName = "Alpha"),
      stream(sourceId = "b1", name = "English 8 GB", addonName = "Beta"),
    )
    assertEquals(listOf("Beta"), Streams.filterOptions(all, filters(language = "en")).addons.map { it.value })
    assertEquals(listOf("cs"), Streams.filterOptions(all, filters(addon = "Alpha")).languages.map { it.value })
  }

  @Test
  fun `filterOptions keeps a chosen addon or language that the other filter emptied`() {
    val all = listOf(
      stream(sourceId = "a1", name = "Czech 1 GB", addonName = "Alpha"),
      stream(sourceId = "b1", name = "English 8 GB", addonName = "Beta"),
    )
    assertTrue(Streams.filterOptions(all, filters(addon = "Beta", language = "cs")).addons.any { it.value == "Beta" && it.count == 0 })
    assertTrue(Streams.filterOptions(all, filters(addon = "Alpha", language = "en")).languages.any { it.value == "en" && it.count == 0 })
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

  // The web's repickStream cases: the default may move, but never under the viewer's feet.
  private val first = "a"
  private val second = "b"
  private val third = "c"

  @Test
  fun `repickStream moves the pick to the first source left when a filter removed the chosen one`() {
    assertEquals(
      Streams.Repick(true, second),
      Streams.repickStream(
        playing = false,
        picked = false,
        pending = 0,
        visible = listOf(second, third),
        selected = first,
        preferred = second,
      ),
    )
  }

  @Test
  fun `repickStream follows a better source that arrives while the viewer is still looking at the list`() {
    assertEquals(
      Streams.Repick(true, second),
      Streams.repickStream(
        playing = false,
        picked = false,
        pending = 2,
        visible = listOf(first, second),
        selected = first,
        preferred = second,
      ),
    )
  }

  @Test
  fun `repickStream never overrides a source the viewer picked themselves`() {
    assertEquals(
      Streams.Repick<String>(false),
      Streams.repickStream(
        playing = false,
        picked = true,
        pending = 2,
        visible = listOf(first, second),
        selected = first,
        preferred = second,
      ),
    )
  }

  @Test
  fun `repickStream leaves the source alone once the film is playing on it`() {
    assertEquals(
      Streams.Repick<String>(false),
      Streams.repickStream(playing = true, picked = false, pending = 2, visible = listOf(first, second), selected = first, preferred = second),
    )
    assertEquals(
      Streams.Repick<String>(false),
      Streams.repickStream(playing = true, picked = false, pending = 0, visible = listOf(second, third), selected = first, preferred = second),
    )
    assertEquals(
      Streams.Repick<String>(false),
      Streams.repickStream(playing = true, picked = false, pending = 0, visible = emptyList(), selected = first, preferred = null),
    )
  }

  @Test
  fun `repickStream clears the pick when nothing is left to play and nobody is watching`() {
    assertEquals(
      Streams.Repick(true, null),
      Streams.repickStream(playing = false, picked = false, pending = 0, visible = emptyList(), selected = first, preferred = null),
    )
    assertEquals(
      Streams.Repick<String>(false),
      Streams.repickStream(playing = false, picked = false, pending = 0, visible = emptyList(), selected = null, preferred = null),
    )
  }

  // The local copy cases from web/src/streams.test.ts.
  private val localStream = stream(
    sourceId = "lib1",
    kind = "library",
    playable = true,
    name = "Heat.mkv",
    libraryName = "Filmy",
    behaviorHints = BehaviorHintsDto(filename = "Heat.mkv"),
  )
  private val addonRemote = stream(sourceId = "s1", name = "FullHD", addonName = "Luna", title = "Czech 2 GB")

  @Test
  fun `isLocalStream recognises a library stream`() {
    assertEquals(true, Streams.isLocalStream(localStream))
    assertEquals(false, Streams.isLocalStream(addonRemote))
  }

  @Test
  fun `streamBadge badges a local copy as LOCAL ahead of playable`() {
    assertEquals("LOCAL", Streams.streamBadge(localStream))
    assertEquals("LOCAL", Streams.streamBadge(stream(kind = "library", playable = false)))
  }

  @Test
  fun `canQueue never queues a copy that is already on disk`() {
    assertEquals(false, Streams.canQueue(localStream, true))
  }

  @Test
  fun `catalogSourceList puts local copies above the addon streams and picks the first`() {
    val rows = Streams.catalogSourceList(listOf(localStream), listOf(addonRemote))
    assertEquals(listOf(localStream, addonRemote), rows)
    assertEquals(localStream, Streams.pickDefaultStream(rows))
  }

  @Test
  fun `catalogSourceList shows a named addon's streams alone, without the local copy`() {
    val visible = Streams.visibleCatalogStreams(listOf(addonRemote), filters(addon = "Luna"), "cs", emptyMap(), true)
    assertEquals(listOf(addonRemote), Streams.catalogSourceList(listOf(localStream), visible, filters(addon = "Luna")))
  }

  @Test
  fun `an addon filter that matches nothing leaves an empty list, not the local copy`() {
    val visible = Streams.visibleCatalogStreams(listOf(addonRemote), filters(addon = "Nope"), "cs", emptyMap(), true)
    assertEquals(emptyList<StreamDto>(), Streams.catalogSourceList(listOf(localStream), visible, filters(addon = "Nope")))
  }

  @Test
  fun `the Local choice of the addon filter shows the library copies alone`() {
    val lists = Streams.sourceLists(listOf(addonRemote), emptyList(), filters(addon = Streams.LOCAL_FILTER), "cs", true, null, local = listOf(localStream))
    assertEquals(listOf(localStream), lists.rows)
    // The choice is offered while there are copies, and never turns up as an addon of its own.
    assertEquals(1, lists.options.localCount)
    assertEquals(false, lists.options.addons.any { it.value == Streams.LOCAL_FILTER })
  }

  @Test
  fun `the Local choice is not offered when the title has no library copy`() {
    val lists = Streams.sourceLists(listOf(addonRemote), emptyList(), filters(), "cs", true, null, local = emptyList())
    assertEquals(0, lists.options.localCount)
  }

  @Test
  fun `the size sorts rank a local copy with the addon rows`() {
    val small = stream(sourceId = "small", name = "SD", addonName = "Luna", title = "100 MB")
    val big = stream(sourceId = "big", name = "HD", addonName = "Luna", title = "9 GB")
    val rows = Streams.catalogSourceList(listOf(localStream), listOf(small), filters(sort = StreamSort.SizeDesc), "cs")
    // Without a size of its own the local copy ranks after the sized addon row, as the web ranks it.
    assertEquals(listOf(small.sourceId), rows.filter { !Streams.isLocalStream(it) }.map { it.sourceId })
    assertEquals(true, rows.contains(localStream))
    assertEquals(listOf(big.sourceId, small.sourceId), Streams.catalogSourceList(emptyList(), listOf(big, small), filters(sort = StreamSort.SizeDesc), "cs").map { it.sourceId })
  }

  @Test
  fun `repickStream moves an automatic addon pick to a local copy that lands once every addon finished`() {
    assertEquals(
      Streams.Repick(true, second),
      Streams.repickStream(playing = false, picked = false, pending = 0, visible = listOf(first, second), selected = first, preferred = second, upgrade = true),
    )
  }

  @Test
  fun `repickStream never moves a source the viewer picked themselves for a local copy`() {
    assertEquals(
      Streams.Repick<String>(false),
      Streams.repickStream(playing = false, picked = true, pending = 0, visible = listOf(first, second), selected = first, preferred = second, upgrade = true),
    )
  }

  @Test
  fun `repickStream never interrupts playback for a local copy that lands`() {
    assertEquals(
      Streams.Repick<String>(false),
      Streams.repickStream(playing = true, picked = false, pending = 0, visible = listOf(first, second), selected = first, preferred = second, upgrade = true),
    )
  }

  @Test
  fun `repickStream leaves a non-upgrade arrival alone when nothing is pending`() {
    assertEquals(
      Streams.Repick<String>(false),
      Streams.repickStream(playing = false, picked = false, pending = 0, visible = listOf(first, second), selected = first, preferred = second, upgrade = false),
    )
  }

  @Test
  fun `recommended with ranks prefers a better-ranked Czech source over a larger English one`() {
    val czech = stream(name = "cz-ranked", title = "Czech 1 GB", addonName = "alpha", rule = verdict("meets", listOf(0.0, 1.0, -1080.0, 3.0)))
    val english = stream(name = "en-big", title = "English 20 GB", addonName = "alpha", rule = verdict("meets", listOf(1.0, 0.0, -1080.0, 3.0)))
    assertEquals(
      listOf("cz-ranked", "en-big"),
      names(Streams.arrangeStreams(listOf(english, czech), filters(sort = StreamSort.of("rule:p1")), "en")),
    )
  }

  @Test
  fun `recommended with ranks puts a breaking source after one that meets the rules`() {
    val meets = stream(name = "meets", title = "Czech 1 GB", addonName = "alpha", rule = verdict("meets", listOf(0.0)))
    val breaks = stream(name = "breaks", title = "Czech 8 GB", addonName = "alpha", rule = verdict("breaks", listOf(1.0), listOf("language")))
    assertEquals(
      listOf("meets", "breaks"),
      names(Streams.arrangeStreams(listOf(breaks, meets), filters(sort = StreamSort.of("rule:p1")), "cs")),
    )
  }

  @Test
  fun `recommended with ranks keeps a stream without a rule after every ranked one`() {
    val ranked = stream(name = "ranked", title = "English 1 GB", addonName = "alpha", rule = verdict("meets", listOf(9.0)))
    val bare = stream(name = "bare", title = "Czech 20 GB", addonName = "alpha")
    assertEquals(
      listOf("ranked", "bare"),
      names(Streams.arrangeStreams(listOf(bare, ranked), filters(sort = StreamSort.of("rule:p1")), "cs")),
    )
  }

  @Test
  fun `recommended without any rule keeps today's language then size order`() {
    assertEquals(listOf("cz-big", "cz-small", "en-big", "unknown"), names(Streams.arrangeStreams(all, filters(), "cs")))
  }

  @Test
  fun `size and addon sorts ignore rule ranks`() {
    val small = stream(name = "cz-small", title = "Czech 1 GB", addonName = "alpha", rule = verdict("meets", listOf(0.0)))
    val big = stream(name = "en-big", title = "English 20 GB", addonName = "beta", rule = verdict("breaks", listOf(9.0)))
    val ranked = listOf(small, big)
    val priority = mapOf("beta" to 0, "alpha" to 1)
    assertEquals(listOf("en-big", "cz-small"), names(Streams.arrangeStreams(ranked, filters(sort = StreamSort.SizeDesc), "cs")))
    assertEquals(listOf("en-big", "cz-small"), names(Streams.arrangeStreams(ranked, filters(sort = StreamSort.Addon), "cs", priority)))
  }

  @Test
  fun `catalogSourceList under a rule sorts local remote and addon together and keeps origins first`() {
    val origin = remote("own", "rlibA", "iA", "Own", verdict("breaks", listOf(9.0)))
    val localRow = stream(
      sourceId = "lib1",
      kind = "library",
      playable = true,
      name = "Local",
      localPath = "/f",
      libraryName = "Filmy",
      rule = verdict("meets", listOf(8.0)),
    )
    val remoteGood = remote("r-good", "rlibB", "iB", "R-good", verdict("meets", listOf(0.0)))
    val remoteBad = remote("r-bad", "rlibB", "iB", "R-bad", verdict("breaks", listOf(2.0)))
    val addonBest = stream(sourceId = "a-best", name = "A-best", addonName = "Luna", rule = verdict("meets", listOf(-1.0)))
    val addonMid = stream(sourceId = "a-mid", name = "A-mid", addonName = "Luna", rule = verdict("meets", listOf(1.0)))
    val rows = Streams.catalogSourceList(
      local = listOf(localRow),
      addon = listOf(addonMid, addonBest),
      filters = filters(sort = StreamSort.of("rule:p1")),
      remote = listOf(Streams.RemoteGroup("rlibB", "emby", "Serial", listOf(remoteBad, remoteGood))),
      origins = Streams.Origins(rows = listOf(origin), libraryId = "rlibA", label = "jellyfin · Film"),
    )
    assertEquals(
      listOf("own", "a-best", "r-good", "a-mid", "r-bad", "lib1"),
      rows.map { it.sourceId },
    )
  }

  @Test
  fun `catalogSourceList under a rule orders origins among themselves and keeps them first`() {
    val originWorse = remote("own-worse", "rlibA", "iA", "Own worse", verdict("breaks", listOf(0.0, 2.0, 360.0), listOf("resolutionLow")))
    val originBest = remote("own-best", "rlibA", "iA", "Own best", verdict("meets", listOf(0.0, 0.0, 1080.0)))
    val addon = stream(sourceId = "addon", name = "Addon", addonName = "Luna", rule = verdict("meets", listOf(0.0, 0.0, 720.0)))
    val rows = Streams.catalogSourceList(
      local = emptyList(),
      addon = listOf(addon),
      filters = filters(sort = StreamSort.of("rule:p1")),
      origins = Streams.Origins(rows = listOf(originWorse, originBest), libraryId = "rlibA", label = "jellyfin · Film"),
    )
    assertEquals(listOf("own-best", "own-worse", "addon"), rows.map { it.sourceId })
  }

  @Test
  fun `a breaking local copy sorts below a meeting addon under an explicit rule and above it under the viewer order`() {
    val origin = remote("own", "rlibA", "iA", "Own", verdict("meets", listOf(0.0, 0.0, 9.0)))
    val breakingLocal = stream(
      sourceId = "lib1",
      kind = "library",
      playable = true,
      name = "Local",
      localPath = "/f",
      rule = verdict("breaks", listOf(0.0, 2.0, 0.0), listOf("size")),
    )
    val meetingAddon = stream(sourceId = "addon", name = "Addon", addonName = "Luna", rule = verdict("meets", listOf(0.0, 0.0, 0.0)))
    val meetingRemote = remote("remote", "rlibB", "iB", "Remote", verdict("meets", listOf(0.0, 0.0, 1.0)))
    val explicit = Streams.catalogSourceList(
      local = listOf(breakingLocal),
      addon = listOf(meetingAddon),
      filters = filters(sort = StreamSort.of("rule:p1")),
      remote = listOf(Streams.RemoteGroup("rlibB", "emby", "Serial", listOf(meetingRemote))),
      origins = Streams.Origins(rows = listOf(origin), libraryId = "rlibA", label = "jellyfin · Film"),
    )
    assertEquals(listOf("own", "addon", "remote", "lib1"), explicit.map { it.sourceId })

    val viewerLocal = breakingLocal.copy(rules = mapOf("p1" to verdict("breaks", listOf(0.0, 2.0, 0.0), listOf("size"))))
    val viewerAddon = meetingAddon.copy(rules = mapOf("p1" to verdict("meets", listOf(1.0, 0.0, 0.0))))
    val viewerRemote = meetingRemote.copy(rules = mapOf("p1" to verdict("meets", listOf(1.0, 0.0, 1.0))))
    val viewer = Streams.catalogSourceList(
      local = listOf(viewerLocal),
      addon = listOf(viewerAddon),
      filters = filters(sort = StreamSort.of("rule:p1")),
      remote = listOf(Streams.RemoteGroup("rlibB", "emby", "Serial", listOf(viewerRemote))),
      origins = Streams.Origins(rows = listOf(origin), libraryId = "rlibA", label = "jellyfin · Film"),
    )
    assertEquals(listOf("own", "lib1", "addon", "remote"), viewer.map { it.sourceId })
  }

  @Test
  fun `a rule sort without verdicts keeps local then remote then addon after the origins`() {
    val origin = remote("own", "rlibA", "iA", "Own")
    val localRow = stream(sourceId = "lib1", kind = "library", playable = true, name = "Local", localPath = "/f")
    val remoteA = remote("r1", "rlibB", "iB", "R1")
    val addonA = stream(sourceId = "a1", name = "A1", addonName = "Luna")
    val rows = Streams.catalogSourceList(
      local = listOf(localRow),
      addon = listOf(addonA),
      filters = filters(sort = StreamSort.of("rule:p1")),
      remote = listOf(Streams.RemoteGroup("rlibB", "emby", "Serial", listOf(remoteA))),
      origins = Streams.Origins(rows = listOf(origin), libraryId = "rlibA", label = "jellyfin · Film"),
    )
    assertEquals(listOf("own", "lib1", "r1", "a1"), rows.map { it.sourceId })
  }

  @Test
  fun `catalogSourceList recommended without any rule keeps today's concatenation`() {
    val origin = remote("own", "rlibA", "iA", "Own")
    val localRow = stream(sourceId = "lib1", kind = "library", playable = true, name = "Local", localPath = "/f")
    val remoteA = remote("r1", "rlibB", "iB", "R1")
    val addonA = stream(sourceId = "a1", name = "A1", addonName = "Luna")
    val rows = Streams.catalogSourceList(
      local = listOf(localRow),
      addon = listOf(addonA),
      remote = listOf(Streams.RemoteGroup("rlibB", "emby", "Serial", listOf(remoteA))),
      origins = Streams.Origins(rows = listOf(origin), libraryId = "rlibA", label = "jellyfin · Film"),
    )
    assertEquals(listOf("own", "lib1", "r1", "a1"), rows.map { it.sourceId })
  }

  @Test
  fun `catalogSourceList addon sort ignores rule ranks`() {
    val remoteGood = remote("r-good", "rlibB", "iB", "R-good", verdict("meets", listOf(0.0)))
    val addonBest = stream(sourceId = "a-best", name = "A-best", addonName = "Luna", rule = verdict("meets", listOf(-1.0)))
    val rows = Streams.catalogSourceList(
      local = emptyList(),
      addon = listOf(addonBest),
      filters = filters(sort = StreamSort.Addon),
      remote = listOf(Streams.RemoteGroup("rlibB", "emby", "Serial", listOf(remoteGood))),
    )
    assertEquals(listOf("r-good", "a-best"), rows.map { it.sourceId })
  }

  @Test
  fun `pickDefaultStream returns the best-ranked playable row`() {
    val best = stream(name = "best", playable = true, title = "1080p 1 GB", rule = verdict("meets", listOf(0.0)))
    val worse = stream(name = "worse", playable = true, title = "1080p 20 GB", rule = verdict("meets", listOf(1.0)))
    val unplayable = stream(name = "unplayable", playable = false, title = "1080p 50 GB", rule = verdict("meets", listOf(-1.0)))
    val arranged = Streams.arrangeStreams(listOf(worse, unplayable, best), filters(sort = StreamSort.of("rule:p1")), "en")
    assertEquals(listOf("unplayable", "best", "worse"), names(arranged))
    assertEquals("best", Streams.pickDefaultStream(arranged)?.name)
  }

  @Test
  fun `pickDefaultStream still opens on the source the viewer last played`() {
    val best = stream(name = "best", playable = true, title = "1080p 1 GB", stableKey = "a:${"1".repeat(24)}", rule = verdict("meets", listOf(0.0)))
    val stored = stream(name = "stored", playable = true, title = "1080p 20 GB", stableKey = "a:${"2".repeat(24)}", rule = verdict("meets", listOf(1.0)))
    val arranged = Streams.arrangeStreams(listOf(stored, best), filters(sort = StreamSort.of("rule:p1")), "en")
    assertEquals("stored", Streams.pickDefaultStream(arranged, preferredStableKey = stored.stableKey)?.name)
  }

  @Test
  fun `pickDefaultStream takes meets then unverified and refuses a row that only breaks the rule`() {
    val breaks = stream(name = "breaks", playable = true, rule = verdict("breaks", listOf(0.0, 2.0), listOf("size")))
    val unverified = stream(name = "unverified", playable = true, rule = verdict("unverified", listOf(0.0, 1.0)))
    val meets = stream(name = "meets", playable = true, rule = verdict("meets", listOf(0.0, 0.0)))
    val unplayableMeets = stream(name = "hidden", playable = false, rule = verdict("meets", listOf(0.0, 0.0)))
    assertEquals("meets", Streams.pickDefaultStream(listOf(breaks, unverified, meets), ruleId = "p1")?.name)
    assertEquals("unverified", Streams.pickDefaultStream(listOf(unplayableMeets, breaks, unverified), ruleId = "p1")?.name)
    assertNull(Streams.pickDefaultStream(listOf(breaks), ruleId = "p1"))
  }

  @Test
  fun `pickDefaultStream keeps the last played row even when it breaks the rule`() {
    val meets = stream(name = "meets", playable = true, stableKey = "a:${"1".repeat(24)}", rule = verdict("meets", listOf(0.0, 0.0)))
    val stored = stream(
      name = "stored",
      playable = true,
      stableKey = "a:${"2".repeat(24)}",
      rule = verdict("breaks", listOf(0.0, 2.0), listOf("torrent")),
    )
    assertEquals("stored", Streams.pickDefaultStream(listOf(meets, stored), preferredStableKey = stored.stableKey, ruleId = "p1")?.name)
  }

  @Test
  fun `pickDefaultStream keeps the old fallback when the rule has no verdict`() {
    val unplayable = stream(name = "unplayable", playable = false)
    val playable = stream(name = "playable", playable = true)
    assertEquals("playable", Streams.pickDefaultStream(listOf(unplayable, playable), ruleId = "p1")?.name)
    assertEquals("unplayable", Streams.pickDefaultStream(listOf(unplayable), ruleId = "p1")?.name)
  }

  @Test
  fun `an explicit pick wins over the rule and an automatic breaking row does not`() {
    val picked = stream(name = "picked", rule = verdict("breaks", listOf(0.0, 2.0), listOf("provider")))
    val meets = stream(name = "meets", rule = verdict("meets", listOf(0.0, 0.0)))
    val remembered = stream(name = "remembered", rule = verdict("breaks", listOf(0.0, 2.0), listOf("size")))
    assertEquals("picked", Streams.selectedPlayRow(picked, picked, meets, "p1")?.name)
    assertEquals("meets", Streams.selectedPlayRow(null, remembered, meets, "p1")?.name)
    assertNull(Streams.selectedPlayRow(null, remembered, null, "p1"))
    assertEquals(true, Streams.needsSourceChoice(listOf(remembered), "p1", null))
    assertEquals(false, Streams.needsSourceChoice(listOf(remembered), "p1", picked))
    assertEquals(false, Streams.needsSourceChoice(listOf(stream(name = "bare")), "p1", null))
  }

  private fun remote(
    sourceId: String,
    libraryId: String,
    itemId: String,
    name: String,
    rule: SourceRuleVerdictDto? = null,
  ) = StreamDto(
    sourceId = sourceId,
    kind = "remote",
    playable = true,
    name = name,
    provider = "jellyfin",
    libraryId = libraryId,
    remoteItem = RemoteItemContext(
      libraryId = libraryId,
      itemId = itemId,
      mediaSourceId = sourceId,
      progressKey = "remote:$libraryId:$itemId",
    ),
    rules = if (rule == null) emptyMap() else mapOf(rule.profileId to rule),
  )

  @Test
  fun `of parses a rule id, the fixed sorts and recommended`() {
    assertEquals(StreamSort.Rule("balanced"), StreamSort.of("rule:balanced"))
    assertEquals("rule:balanced", StreamSort.Rule("balanced").wire)
    assertEquals(StreamSort.SizeDesc, StreamSort.of("size-desc"))
    assertEquals(StreamSort.SizeAsc, StreamSort.of("size-asc"))
    assertEquals(StreamSort.Addon, StreamSort.of("addon"))
    assertEquals(StreamSort.FirstRule, StreamSort.of("recommended"))
    assertEquals(StreamSort.FirstRule, StreamSort.of(null))
    assertEquals(StreamSort.FirstRule, StreamSort.of("nope"))
    assertEquals(StreamSort.FirstRule, StreamSort.of("rule:"))
  }

  @Test
  fun `recommended resolves to the first profile and stays unresolved without one`() {
    assertEquals(StreamSort.Rule("best"), Streams.resolveRuleSort(StreamSort.of("recommended"), listOf("", "best", "small")))
    assertEquals(StreamSort.FirstRule, Streams.resolveRuleSort(StreamSort.of("recommended"), emptyList()))
    assertEquals(StreamSort.SizeDesc, Streams.resolveRuleSort(StreamSort.SizeDesc, listOf("best")))
    assertEquals(StreamSort.Rule("kept"), Streams.resolveRuleSort(StreamSort.of("rule:kept"), listOf("best")))
  }

  @Test
  fun `two rule sorts order the same streams differently`() {
    val alpha = stream(
      name = "alpha",
      title = "English 1 GB",
      rules = mapOf(
        "fast" to verdict("meets", listOf(0.0), profileId = "fast"),
        "best" to verdict("meets", listOf(1.0), profileId = "best"),
      ),
    )
    val beta = stream(
      name = "beta",
      title = "Czech 20 GB",
      rules = mapOf(
        "fast" to verdict("meets", listOf(1.0), profileId = "fast"),
        "best" to verdict("meets", listOf(0.0), profileId = "best"),
      ),
    )
    assertEquals(listOf("alpha", "beta"), names(Streams.arrangeStreams(listOf(beta, alpha), filters(sort = StreamSort.of("rule:fast")), "cs")))
    assertEquals(listOf("beta", "alpha"), names(Streams.arrangeStreams(listOf(alpha, beta), filters(sort = StreamSort.of("rule:best")), "cs")))
  }

  @Test
  fun `a rule sort with no verdict for that profile keeps the old formula`() {
    val czech = stream(
      name = "cz-big",
      title = "Czech 8 GB",
      addonName = "alpha",
      rules = mapOf("other" to verdict("meets", listOf(5.0), profileId = "other")),
    )
    val english = stream(
      name = "en-small",
      title = "English 1 GB",
      addonName = "beta",
      rules = mapOf("other" to verdict("meets", listOf(0.0), profileId = "other")),
    )
    assertEquals(
      listOf("cz-big", "en-small"),
      names(Streams.arrangeStreams(listOf(english, czech), filters(sort = StreamSort.of("rule:mine")), "cs")),
    )
    assertEquals(
      listOf("cz-big", "en-small"),
      names(Streams.arrangeStreams(listOf(english, czech), filters(sort = StreamSort.of("recommended")), "cs")),
    )
  }

  @Test
  fun `the row note follows the active rule and the account rule on a size sort`() {
    val ids = listOf("alpha", "beta")
    assertEquals("beta", Streams.noteProfileId(StreamSort.Rule("beta"), "rule:alpha", ids))
    assertEquals("alpha", Streams.noteProfileId(StreamSort.of("recommended"), "size-asc", ids))
    assertEquals("alpha", Streams.noteProfileId(StreamSort.SizeDesc, "rule:alpha", ids))
    assertEquals("alpha", Streams.noteProfileId(StreamSort.SizeAsc, "recommended", ids))
    assertEquals("alpha", Streams.noteProfileId(StreamSort.Addon, "recommended", ids))
    assertNull(Streams.noteProfileId(StreamSort.SizeDesc, "size-desc", ids))
    assertNull(Streams.noteProfileId(StreamSort.Addon, "addon", ids))
    assertNull(Streams.noteProfileId(StreamSort.FirstRule, "recommended", emptyList()))
  }

  @Test
  fun `a media-server version's own track languages win over its name`() {
    val stream = StreamDto(sourceId = "r", name = "Show S01E01", audioLanguages = listOf("cs", "en", "cs"))
    assertEquals(listOf("cs", "en"), Streams.streamLanguages(stream))
    assertEquals(emptyList<String>(), Streams.streamLanguages(StreamDto(sourceId = "a", name = "Show S01E01")))
  }
}
