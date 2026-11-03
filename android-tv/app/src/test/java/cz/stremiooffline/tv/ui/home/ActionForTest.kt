package cz.stremiooffline.tv.ui.home

import cz.stremiooffline.tv.catalog.ResumeEpisode
import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.HomeProgress
import cz.stremiooffline.tv.data.TitleRefDto
import cz.stremiooffline.tv.playback.Progress
import cz.stremiooffline.tv.ui.catalog.RemoteItemRef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The one click rule every list reads: OK plays a remembered title at once, opens a pending next
 *  episode's detail, and keeps the kinds that stand for nothing else. */
class ActionForTest {

  private fun file(path: String = "browse/A.mkv", title: String = "A") = HomeCard.ResumeFile(
    key = Progress.libraryKey(path),
    title = title,
    path = path,
    progress = HomeProgress(30.0, 120.0),
    forgetKeys = listOf(Progress.libraryKey(path)),
  )

  private fun boundFile(
    type: String = "movie",
    season: Int? = null,
    episode: Int? = null,
  ) = file(title = "Local title").copy(
    season = season,
    episode = episode,
    poster = "poster.jpg",
    identity = TitleRefDto(type = type, id = "tt1"),
    forgetKeys = listOf("${type}:tt1"),
  )

  private fun catalogue(path: String? = null, pending: Boolean = false) = HomeCard.ResumeCatalogue(
    key = "series:tt1:1:2",
    title = "Show · Two",
    type = "series",
    id = "tt1",
    name = "Show",
    season = 1,
    episode = 2,
    path = path,
    pending = pending,
    forgetKeys = listOf("series:tt1:1:2"),
  )

  private fun favorite(
    itemKind: String = "file",
    title: TitleRefDto? = null,
    label: String = "Heat",
  ) = HomeCard.Favorite(key = "browse/Heat", path = "browse/Heat", itemKind = itemKind, label = label, title = title)

  @Test
  fun `a library file opens its own detail`() {
    val card = file()
    val action = actionFor(card)

    assertTrue(action is HomeAction.OpenDetail)
    val detail = (action as HomeAction.OpenDetail).detail
    assertEquals("browse/A.mkv", detail.files.single().path)
    assertEquals("A", detail.title)
  }

  @Test
  fun `a bound resume movie opens the catalogue with its own file`() {
    val action = actionFor(boundFile())

    assertTrue(action is HomeAction.OpenCatalog)
    val args = (action as HomeAction.OpenCatalog).args
    assertEquals("tt1", args.meta.id)
    assertEquals("movie", args.meta.type)
    assertEquals("Local title", args.meta.name)
    assertEquals("poster.jpg", args.meta.poster)
    assertEquals("", args.addonName)
    assertEquals("movie", args.type)
    assertEquals(listOf("movie:tt1"), args.forgetKeys)
    assertEquals("browse/A.mkv", args.preferredLocalPath)
    assertNull(args.episode)
  }

  @Test
  fun `a bound resume episode opens the catalogue on its episode without the file name`() {
    val action = actionFor(boundFile(type = "series", season = 2, episode = 3))

    assertTrue(action is HomeAction.OpenCatalog)
    val args = (action as HomeAction.OpenCatalog).args
    assertEquals("tt1", args.meta.id)
    assertEquals("series", args.meta.type)
    assertEquals("", args.meta.name)
    assertNull(args.meta.poster)
    assertEquals(ResumeEpisode("series:tt1:2:3", 2, 3), args.episode)
    assertEquals("browse/A.mkv", args.preferredLocalPath)
  }

  @Test
  fun `an unbound resume file keeps opening the library detail`() {
    assertTrue(actionFor(file()) is HomeAction.OpenDetail)
  }

  @Test
  fun `a catalogue card that names its file opens its detail without playing`() {
    val action = actionFor(catalogue(path = "browse/A.mkv"))

    assertTrue(action is HomeAction.OpenCatalog)
    val args = (action as HomeAction.OpenCatalog).args
    assertEquals("tt1", args.meta.id)
    assertEquals(false, args.autoPlay)
  }

  @Test
  fun `a catalogue card without a file opens its detail without playing`() {
    val action = actionFor(catalogue())

    assertTrue(action is HomeAction.OpenCatalog)
    val args = (action as HomeAction.OpenCatalog).args
    assertEquals("tt1", args.meta.id)
    assertEquals("series", args.type)
    assertEquals(1, args.episode?.season)
    assertEquals(2, args.episode?.number)
    assertEquals(listOf("series:tt1:1:2"), args.forgetKeys)
    assertEquals(false, args.autoPlay)
  }

  @Test
  fun `a pending next episode opens its detail without playing`() {
    val action = actionFor(catalogue(pending = true))

    assertTrue(action is HomeAction.OpenCatalog)
    assertEquals(false, (action as HomeAction.OpenCatalog).args.autoPlay)
  }

  @Test
  fun `a favourite bound to a title opens that title, file or folder alike`() {
    for (kind in listOf("file", "folder")) {
      val action = actionFor(favorite(itemKind = kind, title = TitleRefDto(type = "movie", id = "tt9")))

      assertTrue(action is HomeAction.OpenCatalog)
      val args = (action as HomeAction.OpenCatalog).args
      assertEquals("tt9", args.meta.id)
      assertEquals("movie", args.type)
      assertEquals("Heat", args.meta.name)
      assertEquals("", args.addonName)
      assertNull(args.episode)
    }
  }

  @Test
  fun `a favourite file passes its local copy to the catalogue detail`() {
    val card = favorite(
      itemKind = "file",
      title = TitleRefDto(type = "movie", id = "tt9"),
    )

    val action = actionFor(card)

    assertTrue(action is HomeAction.OpenCatalog)
    assertEquals(card.path, (action as HomeAction.OpenCatalog).args.preferredLocalPath)
  }

  @Test
  fun `a favourite with no title keeps to the library`() {
    assertTrue(actionFor(favorite(itemKind = "folder")) is HomeAction.OpenLibrary)

    val action = actionFor(favorite())
    assertTrue(action is HomeAction.Play)
    assertEquals(Progress.libraryKey("browse/Heat"), (action as HomeAction.Play).target.key)
  }

  @Test
  fun `a remote card opens its own detail without playing`() {
    val card = HomeCard.Remote(
      key = "remote:1",
      title = "Heat",
      libraryId = "rlibA",
      itemId = "iA",
      itemType = "movie",
      updatedAt = "2026-01-02T00:00:00.000Z",
    )

    val action = actionFor(card)
    assertTrue(action is HomeAction.OpenRemote)
    assertEquals(false, (action as HomeAction.OpenRemote).data.autoPlay)
    assertEquals(card.updatedAt, action.data.updatedAt)
  }

  @Test
  fun `a named remote movie opens the catalogue with its exact server version`() {
    val card = HomeCard.Remote(
      key = "remote:1",
      title = "Heat",
      libraryId = "rlibA",
      itemId = "iA",
      itemType = "movie",
      mediaSourceId = "ms1",
      poster = "poster.jpg",
      identity = TitleRefDto(type = "movie", id = "tt1"),
      forgetKeys = listOf("movie:tt1"),
    )

    val action = actionFor(card)

    assertTrue(action is HomeAction.OpenCatalog)
    val args = (action as HomeAction.OpenCatalog).args
    assertEquals("tt1", args.meta.id)
    assertEquals("movie", args.meta.type)
    assertEquals("Heat", args.meta.name)
    assertEquals("poster.jpg", args.meta.poster)
    assertEquals("", args.addonName)
    assertEquals("movie", args.type)
    assertEquals(listOf("movie:tt1"), args.forgetKeys)
    assertFalse(args.autoPlay)
    assertTrue(args.preferRemote)
    assertEquals(RemoteItemRef("rlibA", "iA", "ms1"), args.preferredRemote)
    assertNull(args.episode)
  }

  @Test
  fun `a named remote episode opens the catalogue on its series season and episode`() {
    val card = HomeCard.Remote(
      key = "remote:2",
      title = "The Rains of Castamere",
      libraryId = "rlibA",
      itemId = "episode-9",
      itemType = "episode",
      mediaSourceId = "ms9",
      season = 2,
      episode = 3,
      identity = TitleRefDto(type = "series", id = "tt9"),
    )

    val action = actionFor(card)

    assertTrue(action is HomeAction.OpenCatalog)
    val args = (action as HomeAction.OpenCatalog).args
    assertEquals("tt9", args.meta.id)
    assertEquals("series", args.meta.type)
    // The card names the episode; the series name and poster come from the catalogue.
    assertEquals("", args.meta.name)
    assertEquals(null, args.meta.poster)
    assertEquals(
      ResumeEpisode("series:tt9:2:3", 2, 3),
      args.episode,
    )
    assertEquals(RemoteItemRef("rlibA", "episode-9", "ms9"), args.preferredRemote)
  }
}
