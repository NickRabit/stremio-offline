package cz.stremiooffline.tv.ui.shell

import cz.stremiooffline.tv.catalog.ResumeEpisode
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.LibraryTitleDto
import cz.stremiooffline.tv.ui.detail.DetailData
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LibraryCatalogueTest {

  private fun file(path: String, season: Int? = null, episode: Int? = null) =
    BrowseItem.File(path = path, label = path.substringAfterLast('/'), season = season, episode = episode)

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
}
