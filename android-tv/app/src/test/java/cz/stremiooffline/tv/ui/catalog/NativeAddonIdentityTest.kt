package cz.stremiooffline.tv.ui.catalog

import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteProviderIdsDto
import cz.stremiooffline.tv.data.LibraryTitleDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The request id one native item can be asked of the addons, and every item that cannot
 *  derive one. */
class NativeAddonIdentityTest {

  private fun movie(ids: RemoteProviderIdsDto = RemoteProviderIdsDto()) =
    RemoteItemDto(id = "iA", name = "Heat", type = "movie", providerIds = ids)

  private fun episode(season: Int? = 1, episode: Int? = 2, ids: RemoteProviderIdsDto = RemoteProviderIdsDto(imdb = "tt9999")) =
    RemoteItemDto(id = "eA", name = "Pilot", type = "episode", season = season, episode = episode, providerIds = ids)

  @Test
  fun `a movie uses its own imdb identity`() {
    assertEquals("movie" to "tt0113277", nativeAddonIdentity(movie(RemoteProviderIdsDto(imdb = "tt0113277")), null))
  }

  @Test
  fun `a movie falls back to its tmdb identity`() {
    assertEquals("movie" to "tmdb:949", nativeAddonIdentity(movie(RemoteProviderIdsDto(tmdb = "949")), null))
  }

  @Test
  fun `a movie with only a tvdb id derives nothing`() {
    assertNull(nativeAddonIdentity(movie(RemoteProviderIdsDto(tvdb = "429")), null))
  }

  @Test
  fun `a movie with no id at all derives nothing`() {
    assertNull(nativeAddonIdentity(movie(RemoteProviderIdsDto(imdb = "heat-1995")), null))
  }

  @Test
  fun `an episode takes its parent series' id and its season zero suffix`() {
    val series = RemoteProviderIdsDto(imdb = "tt0903747")
    assertEquals("series" to "tt0903747:0:1", nativeAddonIdentity(episode(season = 0, episode = 1), series))
  }

  @Test
  fun `an episode takes a tmdb parent id the same way`() {
    val series = RemoteProviderIdsDto(tmdb = "1396")
    assertEquals("series" to "tmdb:1396:5:16", nativeAddonIdentity(episode(season = 5, episode = 16), series))
  }

  @Test
  fun `an episode ignores its own ids`() {
    // The episode's own imdb id is never the request: only the parent's is.
    val item = episode(ids = RemoteProviderIdsDto(imdb = "tt0959621"))
    assertEquals("series" to "tt0903747:1:2", nativeAddonIdentity(item, RemoteProviderIdsDto(imdb = "tt0903747")))
  }

  @Test
  fun `an episode without a parent identity derives nothing`() {
    assertNull(nativeAddonIdentity(episode(), null))
    assertNull(nativeAddonIdentity(episode(), RemoteProviderIdsDto(tvdb = "81189")))
    assertNull(nativeAddonIdentity(episode(), RemoteProviderIdsDto(imdb = "breaking-bad")))
  }

  @Test
  fun `an episode without a season or episode number derives nothing`() {
    val series = RemoteProviderIdsDto(imdb = "tt0903747")
    assertNull(nativeAddonIdentity(episode(season = null), series))
    assertNull(nativeAddonIdentity(episode(episode = null), series))
    assertNull(nativeAddonIdentity(episode(season = -1), series))
    assertNull(nativeAddonIdentity(episode(episode = 0), series))
  }

  @Test
  fun `a series, season or folder derives nothing`() {
    val ids = RemoteProviderIdsDto(imdb = "tt0903747")
    assertNull(nativeAddonIdentity(RemoteItemDto(id = "s", name = "Show", type = "series", providerIds = ids), ids))
    assertNull(nativeAddonIdentity(RemoteItemDto(id = "s", name = "Season 1", type = "season", providerIds = ids), ids))
    assertNull(nativeAddonIdentity(RemoteItemDto(id = "f", name = "Films", type = "folder", providerIds = ids), ids))
  }

  @Test
  fun `an unknown video type derives nothing`() {
    assertNull(nativeAddonIdentity(RemoteItemDto(id = "x", name = "Trailer", type = "video"), null))
    assertNull(nativeAddonIdentity(RemoteItemDto(id = "x", name = "Trailer", type = "video"), RemoteProviderIdsDto(imdb = "tt0903747")))
  }

  @Test
  fun `a library binding keeps a colon-bearing id whole and takes its episode suffix`() {
    // `tmdb:123:4:5` is the series id `tmdb:123` plus its own season and episode, never three
    // colon-separated fields.
    assertEquals(
      "series" to "tmdb:123:4:5",
      libraryAddonIdentity(LibraryTitleDto("series", "tmdb:123", videoId = "tmdb:123:4:5", name = "Show")),
    )
    assertEquals(
      "movie" to "tmdb:123",
      libraryAddonIdentity(LibraryTitleDto("movie", "tmdb:123", name = "Heat")),
    )
  }

  @Test
  fun `a bare or malformed series binding asks nothing`() {
    // The series itself is not the episode's video, and a suffix that is not exactly two numbers
    // is no episode at all.
    assertNull(libraryAddonIdentity(LibraryTitleDto("series", "tmdb:123", name = "Show")))
    assertNull(libraryAddonIdentity(LibraryTitleDto("series", "tmdb:123", videoId = "tmdb:123", name = "Show")))
    assertNull(libraryAddonIdentity(LibraryTitleDto("series", "tmdb:123", videoId = "tmdb:124:4:5", name = "Show")))
    assertNull(libraryAddonIdentity(LibraryTitleDto("series", "tmdb:123", videoId = "tmdb:123:4", name = "Show")))
    assertNull(libraryAddonIdentity(LibraryTitleDto("series", "tmdb:123", videoId = "tmdb:123:4:5:6", name = "Show")))
    assertNull(libraryAddonIdentity(LibraryTitleDto("series", "tmdb:123", videoId = "tmdb:123:x:5", name = "Show")))
    assertNull(libraryAddonIdentity(LibraryTitleDto("series", "tmdb:123", videoId = "tmdb:123:4:0", name = "Show")))
    assertNull(libraryAddonIdentity(LibraryTitleDto("", "", name = "Show")))
    assertNull(libraryAddonIdentity(null))
  }

  @Test
  fun `the episode numbers of a bound file are split after the whole id`() {
    assertEquals(4 to 5, episodeNumbers("tmdb:123", "tmdb:123:4:5"))
    assertEquals(0 to 1, episodeNumbers("tt0903747", "tt0903747:0:1"))
    assertNull(episodeNumbers("tmdb:123", null))
    assertNull(episodeNumbers("tmdb:123", "tmdb:123"))
    assertNull(episodeNumbers("", "4:5"))
  }
}
