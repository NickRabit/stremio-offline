package cz.stremiooffline.tv.ui.shell

import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.TitleRefDto
import cz.stremiooffline.tv.ui.catalog.RemoteItemRef
import cz.stremiooffline.tv.ui.detail.RemoteDetailData
import cz.stremiooffline.tv.ui.detail.RemoteMetadata
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteCatalogueTest {

  private fun data(item: RemoteItemDto, autoPlay: Boolean = false) = RemoteDetailData(
    libraryId = "library",
    libraryName = "Library",
    provider = "jellyfin",
    item = item,
    autoPlay = autoPlay,
  )

  private fun resume(
    key: String,
    libraryId: String = "library",
    itemType: String = "episode",
    seriesId: String = "tt100",
    season: Int? = 1,
    episode: Int? = 2,
  ) = HomeCard.Remote(
    key = key,
    libraryId = libraryId,
    itemId = "resume-$key",
    itemType = itemType,
    mediaSourceId = "source-$key",
    season = season,
    episode = episode,
    identity = TitleRefDto(type = "series", id = seriesId),
  )

  @Test
  fun `a movie opens the catalogue on its exact remote item`() {
    val item = RemoteItemDto(id = "movie", name = "Movie", type = "movie", poster = "/movie.jpg")

    val args = remoteCatalogueArgs(data(item, autoPlay = true), RemoteMetadata(item), "movie" to "tt100", emptyList())

    assertEquals(MetaDto(id = "tt100", type = "movie", name = "Movie", poster = "/movie.jpg"), args.meta)
    assertEquals("", args.addonName)
    assertEquals("movie", args.type)
    assertEquals(true, args.autoPlay)
    assertTrue(args.preferRemote)
    assertEquals(RemoteItemRef("library", "movie"), args.preferredRemote)
    assertNull(args.episode)
  }

  @Test
  fun `an episode selects itself under its catalogue series`() {
    val item = RemoteItemDto(id = "episode", name = "Episode", type = "episode", season = 2, episode = 3)

    val args = remoteCatalogueArgs(data(item), RemoteMetadata(item), "series" to "tt100", emptyList())

    assertEquals(MetaDto(id = "tt100", type = "series"), args.meta)
    assertEquals("series", args.type)
    assertEquals("series:tt100:2:3", args.episode?.key)
    assertEquals(2, args.episode?.season)
    assertEquals(3, args.episode?.number)
    assertEquals(RemoteItemRef("library", "episode"), args.preferredRemote)
  }

  @Test
  fun `a series selects its newest matching resume episode and that exact remote card`() {
    val item = RemoteItemDto(id = "series", name = "Show", type = "series", poster = "/show.jpg")
    val matching = resume("matching")

    val args = remoteCatalogueArgs(
      data(item),
      RemoteMetadata(item),
      "series" to "tt100",
      listOf(matching, resume("older", season = 1, episode = 1)),
    )

    assertEquals(MetaDto(id = "tt100", type = "series", name = "Show", poster = "/show.jpg"), args.meta)
    assertEquals("series:tt100:1:2", args.episode?.key)
    assertEquals(RemoteItemRef("library", "resume-matching", "source-matching"), args.preferredRemote)
  }

  @Test
  fun `a series ignores resume cards that do not name this show in this library`() {
    val item = RemoteItemDto(id = "series", name = "Show", type = "series")
    val mismatches = listOf(
      resume("other-library", libraryId = "other"),
      resume("other-series", seriesId = "tt999"),
      resume("movie", itemType = "movie"),
      resume("missing-season", season = null),
    )

    val args = remoteCatalogueArgs(data(item), RemoteMetadata(item), "series" to "tt100", mismatches)

    assertEquals(MetaDto(id = "tt100", type = "series", name = "Show"), args.meta)
    assertNull(args.episode)
    // No episode in progress: the series still plays from the server it was opened from.
    assertEquals(RemoteItemRef("library", ""), args.preferredRemote)
  }

  @Test
  fun `a season opens its catalogue series without a remote card`() {
    val item = RemoteItemDto(id = "season", name = "Season 1", type = "season", season = 1)

    val args = remoteCatalogueArgs(data(item), RemoteMetadata(item, seriesName = "Show"), "series" to "tt100", emptyList())

    assertEquals(MetaDto(id = "tt100", type = "series", name = "Show"), args.meta)
    assertEquals("series", args.type)
    assertNull(args.episode)
    assertEquals(RemoteItemRef("library", ""), args.preferredRemote)
  }
}
