package cz.stremiooffline.tv.ui.catalog

import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.DownloadTargetSettingsDto
import cz.stremiooffline.tv.data.RemoteProviderIdsDto
import cz.stremiooffline.tv.data.RemoteLibraryApi
import cz.stremiooffline.tv.data.StreamDto
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The media one native copy carries: exact ids and numbers, never a filename or a guess. */
class NativeCopySubjectTest {

  @Test
  fun `a movie keeps its own year and catalogue id`() {
    val item = RemoteItemDto(id = "m1", name = "Heat", type = "movie", year = 1995, providerIds = RemoteProviderIdsDto(imdb = "tt0113277"))
    val subject = nativeCopySubject(item, null, null)
    assertEquals("movie", subject.kind)
    assertEquals("Heat", subject.title)
    assertEquals(1995, subject.year)
    assertEquals("tt0113277", subject.id)
    assertEquals("movie", subject.metaType)
    assertEquals(1995, subject.media().year)
  }

  @Test
  fun `a numeric tmdb id is the catalogue identity when there is no imdb id`() {
    val item = RemoteItemDto(id = "m1", name = "Heat", type = "movie", providerIds = RemoteProviderIdsDto(tmdb = "949"))
    val subject = nativeCopySubject(item, null, null)
    assertEquals("tmdb:949", subject.id)
  }

  @Test
  fun `an episode takes the series title and ids and its own numbers`() {
    val item = RemoteItemDto(id = "e1", name = "Pilot", type = "episode", seriesId = "s1", season = 1, episode = 2)
    val subject = nativeCopySubject(item, "The Show", RemoteProviderIdsDto(imdb = "tt5000"))
    assertEquals("episode", subject.kind)
    assertEquals("The Show", subject.title)
    assertEquals("tt5000", subject.id)
    assertEquals(1, subject.season)
    assertEquals(2, subject.episode)
    assertEquals("Pilot", subject.episodeTitle)
    assertNull(subject.year)
  }

  @Test
  fun `an episode without its parent copies without an id and falls back to its own name`() {
    val item = RemoteItemDto(id = "e1", name = "Clip", type = "episode", season = 1, episode = 4)
    val subject = nativeCopySubject(item, null, null)
    assertNull(subject.id)
    assertNull(subject.metaType)
    assertEquals("Clip", subject.title)
    assertEquals("Clip", subject.episodeTitle)
  }

  @Test
  fun `a provider id that is not a catalogue id is never used`() {
    val item = RemoteItemDto(id = "m1", name = "Heat", type = "movie", providerIds = RemoteProviderIdsDto(imdb = "nope", tmdb = "abc"))
    val subject = nativeCopySubject(item, null, null)
    assertNull(subject.id)
    assertNull(subject.metaType)
  }

  @Test
  fun `the copy title numbers the episode it belongs to`() {
    val item = RemoteItemDto(id = "e1", name = "Pilot", type = "episode", season = 1, episode = 2)
    assertEquals("The Show · S1 · E2", nativeCopyTitle(nativeCopySubject(item, "The Show", null)))
    assertEquals("Heat", nativeCopyTitle(nativeCopySubject(RemoteItemDto(name = "Heat", type = "movie"), null, null)))
  }

  @Test
  fun `the copy request keeps each version's own projected destination`() = runBlocking {
    val api = object : RemoteLibraryApi {
      override suspend fun remoteSources(libraryId: String, itemId: String): List<StreamDto> = listOf(
        StreamDto(sourceId = "s1", kind = "remote", playable = true, downloadTarget = DownloadTargetSettingsDto(libraryId = "box")),
        StreamDto(sourceId = "s2", kind = "remote", playable = true),
      )
    }
    val request = resolveNativeCopy(
      api = api,
      libraryId = "rlib_a",
      item = RemoteItemDto(id = "m1", name = "Heat", type = "movie"),
      seriesName = null,
      seriesIds = null,
      sources = null,
      loadDestinations = { emptyList() },
    )
    // Each version keeps its own rule: the panel reads the destination of the version chosen,
    // never the first version's.
    assertEquals("box", request.versions.first().downloadTarget?.libraryId)
    assertNull(request.versions[1].downloadTarget)
  }

  @Test
  fun `a copy sends no target for the projected destination and an explicit one otherwise`() {
    val projected = StreamDto(sourceId = "s1", kind = "remote", playable = true, downloadTarget = DownloadTargetSettingsDto(libraryId = "box"))
    assertNull(nativeQueueTarget(projected, "box"))
    assertNull(nativeQueueTarget(projected.copy(downloadTarget = null, downloadLibraryId = "box"), "box"))
    assertEquals("libA", nativeQueueTarget(projected, "libA")?.libraryId)
    // With no projection at all a chosen library is a deliberate override, sent explicitly.
    assertEquals("libA", nativeQueueTarget(StreamDto(sourceId = "s2", kind = "remote", playable = true), "libA")?.libraryId)
  }
}
