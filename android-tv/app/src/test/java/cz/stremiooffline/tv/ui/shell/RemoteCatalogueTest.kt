package cz.stremiooffline.tv.ui.shell

import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.HomeProgress
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteItemsPageDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.RemoteBackend
import cz.stremiooffline.tv.ui.detail.RemoteDetailData
import cz.stremiooffline.tv.ui.detail.RemoteMetadata
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteCatalogueTest {

  private fun data(item: RemoteItemDto) = RemoteDetailData(
    libraryId = "library",
    libraryName = "Library",
    provider = "jellyfin",
    item = item,
  )

  private fun episode(id: String, season: Int, number: Int) = RemoteItemDto(
    id = id,
    name = "Episode $number",
    type = "episode",
    seriesId = "show",
    season = season,
    episode = number,
  )

  @Test
  fun `an id-less film uses the server item as its title`() {
    val item = RemoteItemDto(
      id = "film",
      name = "Heat",
      type = "movie",
      year = 1995,
      overview = "A film",
      poster = "poster",
      wide = "backdrop",
      durationTicks = 102_000_000_000L,
    )
    val args = remoteOwnCatalogueArgs(
      data(item),
      item,
      episodes = emptyList(),
      resume = emptyList(),
    )

    assertEquals("remote:library:film", args.meta.id)
    assertEquals("movie", args.meta.type)
    assertEquals("Heat", args.meta.name)
    assertEquals("1995", args.meta.releaseInfo)
    assertEquals("A film", args.meta.description)
    assertEquals("poster", args.meta.poster)
    assertEquals("backdrop", args.meta.background)
    assertEquals("170 min", args.meta.runtime)
    assertTrue(args.backend is RemoteBackend)
    assertFalse(args.backend.catalogue)
  }

  @Test
  fun `an id-less series opens on the resume card for one of its episodes`() {
    val show = RemoteItemDto(id = "show", name = "Show", type = "series")
    val first = episode("e1", 1, 1)
    val second = episode("e2", 1, 2)
    val card = HomeCard.Remote(
      key = "resume",
      libraryId = "library",
      itemId = "e2",
      itemType = "episode",
      season = 1,
      episode = 2,
      mediaSourceId = "source-two",
      progress = HomeProgress(position = 30.0, duration = 100.0),
    )
    val args = remoteOwnCatalogueArgs(data(show), show, listOf(first, second), listOf(card))

    assertEquals("remote:library:show", args.meta.id)
    assertEquals(listOf("remote:library:e1", "remote:library:e2"), args.meta.videos.orEmpty().map { it.id })
    assertEquals(1, args.episode?.season)
    assertEquals(2, args.episode?.number)
    assertEquals("e2", args.preferredRemote?.itemId)
    assertEquals("source-two", args.preferredRemote?.mediaSourceId)
  }

  @Test
  fun `an id-less series without a resume card opens its first episode`() {
    val show = RemoteItemDto(id = "show", name = "Show", type = "series")
    val args = remoteOwnCatalogueArgs(
      data(show),
      show,
      listOf(episode("e1", 1, 1), episode("e2", 1, 2)),
      emptyList(),
    )

    assertEquals(1, args.episode?.season)
    assertEquals(1, args.episode?.number)
    assertEquals(null, args.preferredRemote?.mediaSourceId)
  }

  @Test
  fun `an id-less episode item opens its own episode in the series`() {
    val show = RemoteItemDto(id = "show", name = "Show", type = "series")
    val first = episode("e1", 1, 1)
    val opened = episode("e3", 2, 1)
    val args = remoteOwnCatalogueArgs(
      data(opened),
      show,
      listOf(first, opened),
      emptyList(),
    )

    assertEquals(2, args.episode?.season)
    assertEquals(1, args.episode?.number)
    assertEquals(listOf("remote:library:e1", "remote:library:e3"), args.meta.videos.orEmpty().map { it.id })
  }

  @Test
  fun `a catalogue episode keeps the card's update time`() {
    val opened = episode("e3", 2, 1)
    val updatedAt = "2026-01-02T00:00:00.000Z"
    val args = remoteCatalogueArgs(
      data(opened).copy(updatedAt = updatedAt),
      RemoteMetadata(opened, "Show", null),
      "series" to "tt9",
      emptyList(),
    )

    assertEquals(2, args.episode?.season)
    assertEquals(1, args.episode?.number)
    assertEquals(updatedAt, args.episode?.updatedAt)
  }

  @Test
  fun `a failed series lookup falls back to the item without episodes`() {
    val show = RemoteItemDto(id = "show", name = "Show", type = "series", poster = "poster")
    val args = remoteFallbackCatalogueArgs(data(show))

    assertEquals("remote:library:show", args.meta.id)
    assertEquals("series", args.type)
    assertEquals("Show", args.meta.name)
    assertEquals("poster", args.meta.poster)
    assertTrue(args.meta.videos.orEmpty().isEmpty())
    assertTrue(args.backend is RemoteBackend)
  }

  @Test
  fun `a failed episode lookup keeps the item and reads its own rows lazily`() = runBlocking {
    val item = episode("e1", 1, 1)
    val args = remoteFallbackCatalogueArgs(data(item))
    val api = FakeTvApi()

    assertEquals("episode", args.type)
    assertEquals("Episode 1", args.meta.name)
    assertEquals("e1", args.preferredRemote?.itemId)
    assertTrue(args.meta.videos.orEmpty().isEmpty())
    args.backend.ownRows(api, args.meta.id)
    assertEquals(listOf("library" to "e1"), api.remoteSourcesRequests)
  }

  @Test
  fun `the shell builder follows episode cursors`() = runBlocking {
    val show = RemoteItemDto(id = "show", name = "Show", type = "series")
    val api = FakeTvApi().apply {
      remoteEpisodesPages["show|"] = RemoteItemsPageDto(
        items = listOf(episode("e1", 1, 1)),
        total = 2,
        cursor = "next",
      )
      remoteEpisodesPages["show|next"] = RemoteItemsPageDto(
        items = listOf(episode("e2", 1, 2)),
        total = 2,
      )
    }

    val args = remoteOwnCatalogueArgs(
      api,
      data(show),
      RemoteMetadata(show, show.name, show.providerIds),
    )

    assertEquals(listOf("remote:library:e1", "remote:library:e2"), args?.meta?.videos.orEmpty().map { it.id })
    assertEquals(listOf("show" to null, "show" to "next"), api.remoteEpisodesRequests.map { it.second to it.third })
  }

  @Test
  fun `the shell builder stops after twenty episode pages`() = runBlocking {
    val show = RemoteItemDto(id = "show", name = "Show", type = "series")
    val api = FakeTvApi().apply {
      repeat(25) { page ->
        remoteEpisodesPages["show|${if (page == 0) "" else "page-$page"}"] = RemoteItemsPageDto(
          items = listOf(episode("e$page", 1, page + 1)),
          cursor = "page-${page + 1}",
        )
      }
    }

    val args = remoteOwnCatalogueArgs(
      api,
      data(show),
      RemoteMetadata(show, show.name, show.providerIds),
    )

    assertEquals(20, api.remoteEpisodesRequests.size)
    assertEquals(20, args?.meta?.videos.orEmpty().size)
  }

  @Test
  fun `a server run time becomes minutes and a missing one stays empty`() {
    assertEquals("170 min", remoteRuntime(102_000_000_000L))
    assertEquals(null, remoteRuntime(null))
    assertEquals(null, remoteRuntime(0))
    assertEquals(null, remoteRuntime(100_000_000L))
  }
}
