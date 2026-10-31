package cz.stremiooffline.tv.data

import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.ui.home.HomeAction
import cz.stremiooffline.tv.ui.home.actionFor
import cz.stremiooffline.tv.ui.home.cardLabel
import cz.stremiooffline.tv.ui.home.heroMetaRef
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** One real card per kind, shaped the way `server/src/home.ts` serialises it. */
class HomeCardsTest {

  private val json = Json { ignoreUnknownKeys = true }

  private fun row(body: String): HomeRowDto =
    json.decodeFromString(HomeRowDto.serializer(), body)

  @Test
  fun `every kind decodes to its own card`() {
    val decoded = decodeHomeRow(
      row(
        """
        {"status":"ok","hasMore":false,"items":[
          {"kind":"resume-file","key":"file:a","title":"It","subtitle":"It.mkv","path":"browse/a","progress":{"position":10,"duration":100},"poster":"p","wide":"w","updatedAt":"t","forgetKeys":["file:a"]},
          {"kind":"resume-catalogue","key":"series:x:1:2","title":"Show","type":"series","id":"tt1","name":"Show","season":1,"episode":2,"progress":{"position":5,"duration":50},"updatedAt":"t","forgetKeys":[]},
          {"kind":"completed","key":"file:b","title":"Done","path":"browse/b","poster":"p","completedAt":"t"},
          {"kind":"favorite","key":"file:c","path":"browse/c","itemKind":"file","label":"Fav","poster":"p"},
          {"kind":"recent","key":"file:d","path":"browse/d","label":"New","addedAt":"t","libraryId":"lib","poster":"p"},
          {"kind":"episode","key":"episode:f:v","followId":"f","type":"series","metaId":"tt2","name":"Ep","season":2,"episode":4,"released":"t","poster":"p"},
          {"kind":"discovery","key":"movie:tt3","type":"movie","id":"tt3","name":"Dis","title":"Dis","year":"2001","poster":"p","wide":"w"},
          {"kind":"tonight","key":"file:e","path":"browse/e","itemKind":"folder","label":"Ton","year":"1999","poster":"p","libraryId":"lib"}
        ]}
        """,
      ),
    )

    assertEquals(8, decoded.items.size)
    val kinds = decoded.items.map { it::class.simpleName }
    assertEquals(
      listOf("ResumeFile", "ResumeCatalogue", "Completed", "Favorite", "Recent", "Episode", "Discovery", "Tonight"),
      kinds,
    )
  }

  @Test
  fun `the card helpers read the server's fields`() {
    val decoded = decodeHomeRow(
      row(
        """
        {"status":"ok","hasMore":false,"items":[
          {"kind":"resume-file","key":"file:a","title":"It","subtitle":"It.mkv","path":"browse/a","progress":{"position":25,"duration":100}},
          {"kind":"resume-catalogue","key":"series:x:1:2","title":"Show","type":"series","id":"tt1","name":"Show","season":1,"episode":2,"pending":true},
          {"kind":"favorite","key":"file:c","path":"browse/c","itemKind":"folder","label":"Fav"},
          {"kind":"discovery","key":"movie:tt3","type":"movie","id":"tt3","name":"Dis","title":"Dis","year":"2001"}
        ]}
        """,
      ),
    )

    val resume = decoded.items[0] as HomeCard.ResumeFile
    assertEquals("It", resume.displayTitle)
    assertEquals(0.25f, resume.progressFraction)
    assertEquals("browse/a", resume.libraryPath)

    val catalogue = decoded.items[1] as HomeCard.ResumeCatalogue
    assertEquals("S1 · E2", catalogue.episodeCodeText)
    assertNull("a pending next episode has no bar", catalogue.progressFraction)

    val folder = decoded.items[2] as HomeCard.Favorite
    assertEquals("Fav", folder.displayTitle)
    assertEquals("folder", folder.itemKind)
    assertNull(folder.progressFraction)

    assertEquals("2001", decoded.items[3].yearText)
  }

  @Test
  fun `an unknown kind is skipped, not fatal`() {
    val decoded = decodeHomeRow(
      row(
        """
        {"status":"ok","hasMore":false,"items":[
          {"kind":"confirm","key":"c","label":"Guess"},
          {"kind":"resume-file","key":"file:a","title":"It","path":"browse/a","progress":{"position":1,"duration":10}}
        ]}
        """,
      ),
    )

    assertEquals(1, decoded.items.size)
    assertTrue(decoded.items.single() is HomeCard.ResumeFile)
  }

  @Test
  fun `a remembered film or series resumes, a pending next episode does not`() {
    fun card(type: String, pending: Boolean = false) = HomeCard.ResumeCatalogue(
      key = "$type:tt1",
      type = type,
      id = "tt1",
      name = "Title",
      pending = pending,
    )

    assertEquals(R.string.home_resume, cardLabel(card("movie")))
    assertEquals(R.string.home_resume, cardLabel(card("series")))
    assertEquals(R.string.home_next_episode, cardLabel(card("series", pending = true)))
  }

  @Test
  fun `a Tonight card bound to a title opens that title, an unbound one keeps to the library`() {
    val bound = HomeCard.Tonight(
      key = "lib/Films/Ton",
      path = "lib/Films/Ton",
      itemKind = "folder",
      label = "Ton",
      title = TitleRefDto("movie", "tt9"),
    )
    val action = actionFor(bound)
    assertTrue(action is HomeAction.OpenCatalog)
    val args = (action as HomeAction.OpenCatalog).args
    assertEquals("tt9", args.meta.id)
    assertEquals("movie", args.type)
    assertEquals("Ton", args.meta.name)

    val folder = HomeCard.Tonight(key = "lib/Films/Other", path = "lib/Films/Other", itemKind = "folder", label = "Other")
    assertEquals(HomeAction.OpenLibrary("lib/Films/Other"), actionFor(folder))

    val file = HomeCard.Tonight(key = "lib/Films/Ton.mkv", path = "lib/Films/Ton.mkv", itemKind = "file", label = "Ton")
    assertTrue(actionFor(file) is HomeAction.Play)
  }

  @Test
  fun `completed and recent cards name and open the local file detail`() {
    val completed = HomeCard.Completed(
      key = "file:done",
      title = "Done",
      path = "Films/Done.mkv",
      season = 1,
      episode = 2,
      poster = "poster.jpg",
      wide = "wide.jpg",
    )
    val recent = HomeCard.Recent(key = "file:new", path = "Films/New.mkv", label = "New")

    assertEquals(R.string.home_open_detail, cardLabel(completed))
    assertEquals(R.string.home_open_detail, cardLabel(recent))
    val done = actionFor(completed) as HomeAction.OpenDetail
    val added = actionFor(recent) as HomeAction.OpenDetail
    assertEquals("Films/Done.mkv", done.detail.files.single().path)
    assertEquals("Done", done.detail.title)
    assertEquals(1, done.detail.files.single().season)
    assertEquals(2, done.detail.files.single().episode)
    assertEquals("Films/New.mkv", added.detail.files.single().path)
    assertEquals("New", added.detail.title)
  }

  @Test
  fun `heroMetaRef names the catalogue title a Tonight or favourite card is bound to`() {
    assertEquals("movie" to "tt9", HomeCard.Tonight(key = "k", label = "Ton", title = TitleRefDto("movie", "tt9")).heroMetaRef())
    assertEquals("series" to "tt2", HomeCard.Favorite(key = "k", label = "Fav", title = TitleRefDto("series", "tt2")).heroMetaRef())
    assertNull(HomeCard.Tonight(key = "k", label = "Ton").heroMetaRef())
    assertNull(HomeCard.Favorite(key = "k", label = "Fav").heroMetaRef())
  }

  @Test
  fun `the optional identity, path and forget keys decode, and a body without them still does`() {
    val decoded = decodeHomeRow(
      row(
        """
        {"status":"ok","hasMore":false,"items":[
          {"kind":"resume-file","key":"file:a","title":"It","path":"browse/a","identity":{"type":"movie","id":"tt9"}},
          {"kind":"resume-catalogue","key":"series:x:1:2","title":"Show","type":"series","id":"tt1","name":"Show","path":"browse/a","forgetKeys":["file:a"]},
          {"kind":"favorite","key":"browse/c","path":"browse/c","itemKind":"folder","label":"Fav","title":{"type":"series","id":"tt2"}},
          {"kind":"remote","key":"remote:1","title":"Heat","itemId":"iA","itemType":"movie","identity":{"type":"movie","id":"tt9"},"forgetKeys":["file:a"]}
        ]}
        """,
      ),
    )

    assertEquals(TitleRefDto("movie", "tt9"), (decoded.items[0] as HomeCard.ResumeFile).identity)
    assertEquals("browse/a", (decoded.items[1] as HomeCard.ResumeCatalogue).path)
    assertEquals(listOf("file:a"), (decoded.items[1] as HomeCard.ResumeCatalogue).forgetKeys)
    assertEquals(TitleRefDto("series", "tt2"), (decoded.items[2] as HomeCard.Favorite).title)
    assertEquals(TitleRefDto("movie", "tt9"), (decoded.items[3] as HomeCard.Remote).identity)
    assertEquals(listOf("file:a"), (decoded.items[3] as HomeCard.Remote).forgetKeys)

    // The same kinds arrive without them from an older server.
    val plain = decodeHomeRow(
      row(
        """
        {"status":"ok","hasMore":false,"items":[
          {"kind":"resume-file","key":"file:a","title":"It","path":"browse/a"},
          {"kind":"resume-catalogue","key":"series:x:1:2","title":"Show","type":"series","id":"tt1","name":"Show"},
          {"kind":"favorite","key":"browse/c","path":"browse/c","itemKind":"folder","label":"Fav"},
          {"kind":"remote","key":"remote:1","title":"Heat","itemId":"iA","itemType":"movie"}
        ]}
        """,
      ),
    )

    assertNull((plain.items[0] as HomeCard.ResumeFile).identity)
    assertNull((plain.items[1] as HomeCard.ResumeCatalogue).path)
    assertTrue((plain.items[1] as HomeCard.ResumeCatalogue).forgetKeys.isEmpty())
    assertNull((plain.items[2] as HomeCard.Favorite).title)
    assertNull((plain.items[3] as HomeCard.Remote).identity)
    assertTrue((plain.items[3] as HomeCard.Remote).forgetKeys.isEmpty())
  }

  @Test
  fun `an error row keeps its status and has no cards`() {
    val decoded = decodeHomeRow(row("""{"status":"error","error":{"error":"boom"},"items":[],"hasMore":false}"""))

    assertEquals(HomeRowStatus.Error, decoded.status)
    assertTrue(decoded.items.isEmpty())
  }
}
