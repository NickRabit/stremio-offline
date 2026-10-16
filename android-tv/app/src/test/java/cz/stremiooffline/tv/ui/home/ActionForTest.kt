package cz.stremiooffline.tv.ui.home

import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.HomeProgress
import cz.stremiooffline.tv.data.TitleRefDto
import cz.stremiooffline.tv.playback.Progress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The one click rule every list reads: OK plays the version a card was written from, opens the
 *  title a copy is bound to, and keeps the kinds that stand for nothing else. */
class ActionForTest {

  private fun file(path: String = "browse/A.mkv", title: String = "A") = HomeCard.ResumeFile(
    key = Progress.libraryKey(path),
    title = title,
    path = path,
    progress = HomeProgress(30.0, 120.0),
    forgetKeys = listOf(Progress.libraryKey(path)),
  )

  private fun catalogue(path: String? = null) = HomeCard.ResumeCatalogue(
    key = "series:tt1:1:2",
    title = "Show · Two",
    type = "series",
    id = "tt1",
    name = "Show",
    season = 1,
    episode = 2,
    path = path,
    forgetKeys = listOf("series:tt1:1:2"),
  )

  private fun favorite(
    itemKind: String = "file",
    title: TitleRefDto? = null,
    label: String = "Heat",
  ) = HomeCard.Favorite(key = "browse/Heat", path = "browse/Heat", itemKind = itemKind, label = label, title = title)

  @Test
  fun `a library file plays itself`() {
    val card = file()
    val action = actionFor(card)

    assertTrue(action is HomeAction.Play)
    val target = (action as HomeAction.Play).target
    assertEquals(Progress.libraryKey("browse/A.mkv"), target.key)
    assertEquals("browse/A.mkv", target.path)
    assertEquals("A", target.title)
    assertTrue(target.resume)
  }

  @Test
  fun `a catalogue card that names its file plays that file`() {
    val action = actionFor(catalogue(path = "browse/A.mkv"))

    assertTrue(action is HomeAction.Play)
    val target = (action as HomeAction.Play).target
    assertEquals(Progress.libraryKey("browse/A.mkv"), target.key)
    assertEquals("browse/A.mkv", target.path)
    assertTrue(target.resume)
  }

  @Test
  fun `a catalogue card without a file opens the episode it remembers`() {
    val action = actionFor(catalogue())

    assertTrue(action is HomeAction.OpenCatalog)
    val args = (action as HomeAction.OpenCatalog).args
    assertEquals("tt1", args.meta.id)
    assertEquals("series", args.type)
    assertEquals(1, args.episode?.season)
    assertEquals(2, args.episode?.number)
    assertEquals(listOf("series:tt1:1:2"), args.forgetKeys)
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
  fun `a favourite with no title keeps to the library`() {
    assertTrue(actionFor(favorite(itemKind = "folder")) is HomeAction.OpenLibrary)

    val action = actionFor(favorite())
    assertTrue(action is HomeAction.Play)
    assertEquals(Progress.libraryKey("browse/Heat"), (action as HomeAction.Play).target.key)
  }

  @Test
  fun `a remote card keeps opening its own playable detail`() {
    val card = HomeCard.Remote(key = "remote:1", title = "Heat", libraryId = "rlibA", itemId = "iA", itemType = "movie")

    assertTrue(actionFor(card) is HomeAction.OpenRemote)
  }
}
