package cz.stremiooffline.tv.catalog

import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.StreamDto
import org.junit.Assert.assertEquals
import org.junit.Test

/** The remote source groups: their order, their filter exclusivity and their option descriptors. */
class RemoteSourceGroupsTest {

  private fun remote(sourceId: String, libraryId: String, itemId: String, name: String) = StreamDto(
    sourceId = sourceId,
    kind = "remote",
    playable = true,
    name = name,
    provider = "jellyfin",
    libraryId = libraryId,
    remoteItem = RemoteItemContext(libraryId = libraryId, itemId = itemId, mediaSourceId = sourceId, progressKey = "remote:$libraryId:$itemId"),
  )

  private fun addon(sourceId: String, name: String, addonName: String = "Luna") = StreamDto(
    sourceId = sourceId,
    kind = "remote",
    playable = true,
    name = name,
    addonName = addonName,
  )

  private fun local(path: String, name: String) = StreamDto(
    sourceId = "lib-$path",
    kind = "library",
    playable = true,
    name = name,
    localPath = path,
    libraryName = "Filmy",
  )

  private fun group(libraryId: String, provider: String, name: String, vararg streams: StreamDto) =
    Streams.RemoteGroup(libraryId, provider, name, streams.toList())

  @Test
  fun `recommended order is local, then remote groups, then addons`() {
    val a = remote("a1", "rlibA", "iA", "A")
    val b = remote("b1", "rlibB", "iB", "B")
    val x = addon("x1", "X")
    val lg = local("/f", "L")
    val rows = Streams.catalogSourceList(
      local = listOf(lg),
      addon = listOf(x),
      remote = listOf(group("rlibA", "jellyfin", "Film", a), group("rlibB", "emby", "Serial", b)),
    )
    assertEquals(listOf(lg.sourceId, a.sourceId, b.sourceId, x.sourceId), rows.map { it.sourceId })
  }

  @Test
  fun `a remote filter shows that group alone, and nothing when it matched nothing`() {
    val a = remote("a1", "rlibA", "iA", "A")
    val x = addon("x1", "X")
    val onlyA = Streams.catalogSourceList(
      local = emptyList(),
      addon = listOf(x),
      filters = Streams.StreamFilters(addon = Streams.remoteFilter("rlibA")),
      remote = listOf(group("rlibA", "jellyfin", "Film", a)),
    )
    assertEquals(listOf(a.sourceId), onlyA.map { it.sourceId })

    val none = Streams.catalogSourceList(
      local = emptyList(),
      addon = listOf(x),
      filters = Streams.StreamFilters(addon = Streams.remoteFilter("rlibB")),
      remote = listOf(group("rlibA", "jellyfin", "Film", a)),
    )
    assertEquals(emptyList<StreamDto>(), none)
  }

  @Test
  fun `the Local filter stays untouched by remote groups`() {
    val a = remote("a1", "rlibA", "iA", "A")
    val lg = local("/f", "L")
    val rows = Streams.catalogSourceList(
      local = listOf(lg),
      addon = emptyList(),
      filters = Streams.StreamFilters(addon = Streams.LOCAL_FILTER),
      remote = listOf(group("rlibA", "jellyfin", "Film", a)),
    )
    assertEquals(listOf(lg), rows)
  }

  @Test
  fun `a remote group is offered by its own descriptor and never as an addon`() {
    val a = remote("a1", "rlibA", "iA", "A")
    val x = addon("x1", "X")
    val options = Streams.filterOptions(
      listed = listOf(x),
      filters = Streams.StreamFilters(),
      remote = listOf(group("rlibA", "jellyfin", "Film", a)),
    )
    assertEquals(listOf("Luna"), options.addons.map { it.value })
    assertEquals(1, options.remoteGroups.size)
    assertEquals(Streams.remoteFilter("rlibA"), options.remoteGroups.single().value)
    assertEquals("jellyfin · Film", options.remoteGroups.single().label)
    assertEquals(1, options.remoteGroups.single().count)
  }

  @Test
  fun `a chosen remote group with no match stays offered at zero`() {
    val options = Streams.filterOptions(
      listed = emptyList(),
      filters = Streams.StreamFilters(addon = Streams.remoteFilter("rlibB")),
      remote = listOf(group("rlibB", "emby", "Serial")),
    )
    assertEquals(Streams.remoteFilter("rlibB"), options.remoteGroups.single().value)
    assertEquals(0, options.remoteGroups.single().count)
  }

  @Test
  fun `remoteVersionsOf keeps one item's versions and no other item's`() {
    val a1 = remote("a1", "rlibA", "iA", "A1")
    val a2 = remote("a2", "rlibA", "iA", "A2")
    val b1 = remote("b1", "rlibB", "iB", "B1")
    val other = remote("a3", "rlibA", "iC", "A3")
    assertEquals(listOf("a1", "a2"), Streams.remoteVersionsOf(a1.remoteItem, listOf(a1, a2, b1, other)).map { it.sourceId })
    assertEquals(emptyList<StreamDto>(), Streams.remoteVersionsOf(null, listOf(a1)))
  }
}
