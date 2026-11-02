package cz.stremiooffline.tv.ui.shell

import cz.stremiooffline.tv.catalog.ResumeEpisode
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.LibraryTitleDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.ui.catalog.LibraryBackend
import cz.stremiooffline.tv.ui.detail.DetailData
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LibraryCatalogueTest {

  private fun file(
    path: String,
    season: Int? = null,
    episode: Int? = null,
    size: Double = 0.0,
    progress: ProgressDto? = null,
  ) = BrowseItem.File(
    path = path,
    label = path.substringAfterLast('/'),
    season = season,
    episode = episode,
    size = size,
    progress = progress,
  )

  private fun detail(vararg files: BrowseItem.File) = DetailData(
    gridPath = "folder",
    title = "Library title",
    year = null,
    description = null,
    poster = "poster.jpg",
    wide = null,
    size = files.sumOf { it.size },
    fileCount = files.size,
    files = files.toList(),
    forgetKeys = listOf("file:${files.first().path}"),
  )

  @Test
  fun `a single movie file opens with that copy and the movie's name`() {
    val args = libraryCatalogueArgs(
      detail(file("Films/Heat.mkv")),
      LibraryTitleDto(type = "movie", id = "tt1", name = "Heat"),
    )

    assertEquals("tt1", args.meta.id)
    assertEquals("movie", args.meta.type)
    assertEquals("Heat", args.meta.name)
    assertEquals("poster.jpg", args.meta.poster)
    assertEquals("", args.addonName)
    assertEquals("movie", args.type)
    assertEquals(listOf("file:Films/Heat.mkv"), args.forgetKeys)
    assertEquals("Films/Heat.mkv", args.preferredLocalPath)
    assertNull(args.episode)
  }

  @Test
  fun `a single episode file opens the series on that episode`() {
    val path = "Shows/Show/Show.S02E03.mkv"
    val args = libraryCatalogueArgs(
      detail(file(path, season = 2, episode = 3)),
      LibraryTitleDto(type = "series", id = "tt9", videoId = "tt9:2:3", name = "Show"),
    )

    assertEquals("tt9", args.meta.id)
    assertEquals("series", args.meta.type)
    assertEquals("", args.meta.name)
    // An episode file's picture is not the series poster.
    assertNull(args.meta.poster)
    assertEquals("series", args.type)
    assertEquals(path, args.preferredLocalPath)
    assertEquals(ResumeEpisode("series:tt9:2:3", 2, 3), args.episode)
  }

  @Test
  fun `an episode file whose name carries no numbers opens on the episode the server bound`() {
    val path = "Shows/Show/Pilot.mkv"
    val args = libraryCatalogueArgs(
      detail(file(path)),
      LibraryTitleDto(type = "series", id = "tt9", videoId = "tt9:1:1", name = "Show"),
    )

    assertEquals(ResumeEpisode("series:tt9:1:1", 1, 1), args.episode)
    assertEquals(path, args.preferredLocalPath)
  }

  @Test
  fun `a movie folder with versions leaves the copy and episode to the catalogue detail`() {
    val args = libraryCatalogueArgs(
      detail(file("Films/Heat/Heat.1080p.mkv"), file("Films/Heat/Heat.2160p.mkv")),
      LibraryTitleDto(type = "movie", id = "tt1", name = "Heat"),
    )

    assertEquals("Heat", args.meta.name)
    assertNull(args.preferredLocalPath)
    assertNull(args.episode)
  }

  @Test
  fun `a series folder leaves the copy and episode to the catalogue detail`() {
    val args = libraryCatalogueArgs(
      detail(
        file("Shows/Show/Show.S01E01.mkv", season = 1, episode = 1),
        file("Shows/Show/Show.S01E02.mkv", season = 1, episode = 2),
      ),
      LibraryTitleDto(type = "series", id = "tt9", name = "Show"),
    )

    assertEquals("", args.meta.name)
    assertNull(args.preferredLocalPath)
    assertNull(args.episode)
  }

  @Test
  fun `an unbound film builds its own title from the single file`() {
    val path = "Films/Heat.mkv"
    val args = ownCatalogueArgs(detail(file(path)))

    assertEquals("local:folder", args.meta.id)
    assertEquals("movie", args.meta.type)
    assertEquals("Library title", args.meta.name)
    assertEquals("poster.jpg", args.meta.poster)
    assertEquals("poster.jpg", args.meta.background)
    assertEquals("movie", args.type)
    val backend = args.backend as LibraryBackend
    assertEquals("folder", backend.favouritePath)
    assertEquals(false, backend.favourite)
    assertEquals(listOf(path), backend.rows["local:folder"]?.map { it.localPath })
  }

  @Test
  fun `an unbound film folder keeps every version largest first`() {
    val small = "Films/Heat/Heat.1080p.mkv"
    val large = "Films/Heat/Heat.2160p.mkv"
    val args = ownCatalogueArgs(
      detail(file(small, size = 4_000_000_000.0), file(large, size = 12_000_000_000.0)),
    )

    assertEquals(
      listOf(large, small),
      (args.backend as LibraryBackend).rows["local:folder"]?.map { it.localPath },
    )
    assertNull(args.meta.videos)
  }

  @Test
  fun `an unbound series opens on the first file not watched to the end`() {
    val first = "Shows/Show/Show.S01E01.mkv"
    val second = "Shows/Show/Show.S01E02.mkv"
    val args = ownCatalogueArgs(
      detail(
        file(first, season = 1, episode = 1, progress = ProgressDto(120.0, 120.0)),
        file(second, season = 1, episode = 2, progress = ProgressDto(40.0, 120.0)),
      ),
    )
    val videos = args.meta.videos.orEmpty()

    assertEquals("series", args.meta.type)
    assertEquals(listOf("local:$first", "local:$second"), videos.map { it.id })
    assertEquals(listOf(1, 2), videos.map { it.episode })
    assertEquals(listOf("Show.S01E01.mkv", "Show.S01E02.mkv"), videos.map { it.title })
    assertEquals(ResumeEpisode("series:local:$second", 1, 2), args.episode)
    assertEquals(second, (args.backend as LibraryBackend).rows["local:$second"]?.single()?.localPath)
  }
}
