package cz.stremiooffline.tv.data

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
  fun `an error row keeps its status and has no cards`() {
    val decoded = decodeHomeRow(row("""{"status":"error","error":{"error":"boom"},"items":[],"hasMore":false}"""))

    assertEquals(HomeRowStatus.Error, decoded.status)
    assertTrue(decoded.items.isEmpty())
  }
}
