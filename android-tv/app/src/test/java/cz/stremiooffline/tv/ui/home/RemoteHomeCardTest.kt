package cz.stremiooffline.tv.ui.home

import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.HomeCardsJson
import cz.stremiooffline.tv.data.displayTitle
import cz.stremiooffline.tv.data.drawnWide
import cz.stremiooffline.tv.data.episodeCodeText
import cz.stremiooffline.tv.data.isWideKind
import cz.stremiooffline.tv.data.libraryPath
import cz.stremiooffline.tv.data.progressFraction
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A Home/Resume remote card decodes, renders and maps to the native detail without a fake path. */
class RemoteHomeCardTest {

  private fun decode(json: String): HomeCard = HomeCardsJson.decodeFromString(HomeCard.serializer(), json)

  private val movie = """
    {"kind":"remote","key":"remote:1","title":"Heat","provider":"jellyfin","libraryId":"rlibA",
     "libraryName":"Filmy","itemId":"iA","itemType":"movie","mediaSourceId":"ms1",
     "poster":"/img/p","wide":"/img/w","progress":{"position":10.0,"duration":100.0},
     "updatedAt":"2026-01-01T00:00:00Z"}
  """.trimIndent()

  @Test
  fun `a remote card decodes and renders its title and progress`() {
    val card = decode(movie)
    assertTrue(card is HomeCard.Remote)
    val remote = card as HomeCard.Remote
    assertEquals("Heat", remote.displayTitle)
    // A list never names the server or its library; this row carries no numbering or year.
    assertNull(captionOf(remote, null))
    assertEquals(0.1f, remote.progressFraction!!, 0.001f)
    assertEquals(false, remote.isWideKind)
  }

  @Test
  fun `an episode remote card is wide and numbered`() {
    val card = decode("""{"kind":"remote","key":"remote:2","title":"Pilot","itemType":"episode","season":1,"episode":3}""")
    val remote = card as HomeCard.Remote
    assertEquals(true, remote.isWideKind)
    assertEquals("S1 · E3", remote.episodeCodeText)
  }

  @Test
  fun `a remote card carries no path and asks for no catalogue metadata`() {
    val remote = decode(movie) as HomeCard.Remote
    assertNull(remote.libraryPath)
    assertNull(remote.heroMetaRef())
  }

  @Test
  fun `a remote film is drawn wide in Continue watching and unchanged in any other row`() {
    val remote = decode(movie) as HomeCard.Remote
    assertEquals(true, remote.drawnWide("resume"))
    assertEquals(false, remote.drawnWide("favorites"))
  }

  @Test
  fun `a remote card the provider bound to a title asks the catalogue about it`() {
    val bound = decode(
      """{"kind":"remote","key":"remote:3","title":"Heat","provider":"jellyfin","libraryId":"rlibA",
         "itemId":"iA","itemType":"movie","identity":{"type":"movie","id":"tt9"}}""",
    ) as HomeCard.Remote
    assertEquals("movie" to "tt9", bound.heroMetaRef())
  }

  @Test
  fun `OK on a remote card opens its native detail with opaque identity only`() {
    val remote = decode(movie) as HomeCard.Remote
    val action = actionFor(remote)
    assertTrue(action is HomeAction.OpenRemote)
    val data = (action as HomeAction.OpenRemote).data
    assertEquals("rlibA", data.libraryId)
    assertEquals("Filmy", data.libraryName)
    assertEquals("jellyfin", data.provider)
    assertEquals("iA", data.item.id)
    assertEquals("movie", data.item.type)
    assertEquals("/img/p", data.item.poster)
  }
}
