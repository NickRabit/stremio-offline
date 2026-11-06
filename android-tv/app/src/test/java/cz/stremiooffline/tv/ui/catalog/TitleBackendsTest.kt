package cz.stremiooffline.tv.ui.catalog

import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.HomeProgress
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteItemStateDto
import cz.stremiooffline.tv.data.RemotePersonalPage
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.ui.FakeTvApi
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TitleBackendsTest {

  private fun video(id: String, season: Int, episode: Int) =
    VideoDto(id = id, season = season, episode = episode, title = id)

  private fun local(path: String) = StreamDto(
    sourceId = "file:$path",
    kind = "library",
    playable = true,
    localPath = path,
  )

  private fun remote(libraryId: String, itemId: String) = StreamDto(
    sourceId = "remote:$itemId",
    kind = "remote",
    playable = true,
    provider = "jellyfin",
    libraryName = "Library",
    remoteItem = RemoteItemContext(
      libraryId = libraryId,
      itemId = itemId,
      mediaSourceId = "source",
      progressKey = "remote:$libraryId:$itemId",
    ),
  )

  @Test
  fun `the library backend keeps the file rows and file actions`() = runBlocking {
    val first = "Shows/One.mkv"
    val second = "Shows/Two.mkv"
    val backend = LibraryBackend(
      rows = mapOf(
        "local:$first" to listOf(local(first)),
        "local:$second" to listOf(local(second)),
      ),
      favouritePath = "Shows",
      favourite = false,
      progress = emptyMap(),
    )
    val api = FakeTvApi().apply {
      progressValues["file:$second"] = cz.stremiooffline.tv.data.ProgressDto(25.0, 100.0)
    }

    assertEquals(listOf(first), backend.ownRows(api, "local:$first")?.map { it.localPath })
    assertEquals(false, backend.favourite(api))
    assertEquals(true, backend.setFavourite(api, true))
    assertEquals(listOf("Shows" to true), api.libraryFavoriteCalls)

    assertTrue(backend.markWatched(api, local(second), "Show", "poster"))
    assertEquals("file:$second", api.progressSaves.single().key)
    assertTrue(api.progressSaves.single().final)

    assertTrue(backend.forget(api, local(first)))
    assertEquals(listOf(listOf("file:$first")), api.forgetCalls)

    val progress = backend.episodeProgress(api)
    assertEquals(0.25f, ownEpisodeProgress(progress, "local:$second")!!, 0.001f)
    assertNull(backend.toLibrary(local(first)))
  }

  @Test
  fun `the remote backend filters rows and patches the item or active episode`() = runBlocking {
    val film = RemoteItemDto(id = "film", name = "Heat", type = "movie")
    val backend = RemoteBackend(
      libraryId = "library",
      libraryName = "Library",
      provider = "jellyfin",
      item = film,
    )
    val api = FakeTvApi().apply {
      remoteSourcesValue = listOf(remote("library", "film"), StreamDto(sourceId = "addon", kind = "remote", playable = true))
      remoteStateValue = RemoteItemStateDto(favorite = true)
    }

    val rows = backend.ownRows(api, "remote:library:film")
    assertEquals(listOf("remote:film"), rows.map { it.sourceId })
    assertEquals(true, backend.favourite(api))
    assertEquals(false, backend.setFavourite(api, false))
    assertEquals("library" to "film", api.remoteStatePatchRequests.single().let { it.first to it.second })
    assertEquals(false, api.remoteStatePatchRequests.single().third.favorite)

    assertTrue(backend.markWatched(api, remote("library", "episode"), "Heat", null))
    assertEquals("episode", api.remoteStatePatchRequests.last().second)
    assertEquals(true, api.remoteStatePatchRequests.last().third.watched)

    api.remoteStateValue = RemoteItemStateDto(position = 20.0, duration = 100.0, watched = true)
    assertTrue(backend.forget(api, remote("library", "episode")))
    val clear = api.remoteStatePatchRequests.last()
    assertEquals("episode", clear.second)
    assertEquals(0.0, clear.third.position)
    assertEquals(0.0, clear.third.duration)
    assertEquals(true, clear.third.final)
    assertEquals(false, clear.third.watched)
  }

  @Test
  fun `the remote backend maps resume cards to episode progress`() = runBlocking {
    val first = RemoteItemDto(id = "e1", name = "One", type = "episode", seriesId = "show", season = 1, episode = 1)
    val second = RemoteItemDto(id = "e2", name = "Two", type = "episode", seriesId = "show", season = 1, episode = 2)
    val backend = RemoteBackend(
      libraryId = "library",
      libraryName = "Library",
      provider = "jellyfin",
      item = RemoteItemDto(id = "show", name = "Show", type = "series"),
      episodes = listOf(first, second),
    )
    val api = FakeTvApi().apply {
      remotePersonalValue = RemotePersonalPage(
        items = listOf(
          HomeCard.Remote(
            key = "resume",
            libraryId = "library",
            itemId = "e2",
            itemType = "episode",
            progress = HomeProgress(position = 50.0, duration = 100.0),
          ),
        ),
        total = 1,
        partial = false,
      )
    }

    val progress = backend.episodeProgress(api)
    assertEquals(0.5f, ownEpisodeProgress(progress, "remote:library:e2")!!, 0.001f)
    assertFalse(ownEpisodeCompleted(progress, "remote:library:e2"))
    assertEquals(listOf(Triple("resume", 0, 60)), api.remotePersonalRequests)
    assertTrue(api.progressRequests.isEmpty())
  }

  @Test
  fun `a finished own episode hands over to the next unfinished one`() {
    val first = video("e1", 1, 1)
    val second = video("e2", 1, 2)
    val third = video("e3", 1, 3)
    val progress = mapOf("e1" to ProgressDto(1.0, 1.0))

    assertEquals(second, ownEpisodeAfterPlay(listOf(first, second, third), first, progress))
  }

  @Test
  fun `an unfinished own episode keeps its selection`() {
    val first = video("e1", 1, 1)
    val second = video("e2", 1, 2)

    assertNull(ownEpisodeAfterPlay(listOf(first, second), first, emptyMap()))
    assertNull(ownEpisodeAfterPlay(listOf(first, second), null, emptyMap()))
  }

  @Test
  fun `a finished own series selects the last episode when every episode is done`() {
    val first = video("e1", 1, 1)
    val second = video("e2", 1, 2)
    val third = video("e3", 1, 3)
    val progress = listOf(first, second, third).associate { it.id!! to ProgressDto(1.0, 1.0) }

    assertEquals(third, ownEpisodeAfterPlay(listOf(first, second, third), first, progress))
  }

  @Test
  fun `specials sort after regular seasons when a finished episode hands over`() {
    val first = video("e1", 1, 1)
    val second = video("e2", 1, 2)
    val special = video("special", 0, 1)
    val progress = mapOf(
      "e1" to ProgressDto(1.0, 1.0),
      "e2" to ProgressDto(1.0, 1.0),
    )

    assertEquals(special, ownEpisodeAfterPlay(listOf(special, first, second), first, progress))
  }
}
