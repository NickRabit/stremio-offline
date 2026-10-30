package cz.stremiooffline.tv.ui.detail

import cz.stremiooffline.tv.data.RemoteItemDetailDto
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteProviderIdsDto
import cz.stremiooffline.tv.ui.FakeTvApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RemoteMetadataTest {

  private fun data(
    item: RemoteItemDto,
    seriesName: String? = null,
    seriesIds: RemoteProviderIdsDto? = null,
  ) = RemoteDetailData("rlibA", "Films", "jellyfin", item, seriesName, seriesIds)

  @Test
  fun `a partial movie reads its exact provider identity`() = runTest {
    val api = FakeTvApi()
    api.remoteItemValues["rlibA:m1"] = RemoteItemDetailDto(
      RemoteItemDto(id = "m1", name = "Heat", type = "movie", providerIds = RemoteProviderIdsDto(imdb = "tt0113277")),
    )

    val resolved = resolveRemoteMetadata(api, data(RemoteItemDto(id = "m1", name = "Heat", type = "movie")))

    assertEquals("tt0113277", resolved.item.providerIds.imdb)
    assertEquals(listOf("rlibA" to "m1"), api.remoteItemRequests)
  }

  @Test
  fun `a direct episode reads its exact parent and never uses its own provider id`() = runTest {
    val api = FakeTvApi()
    api.remoteItemValues["rlibA:e1"] = RemoteItemDetailDto(
      RemoteItemDto(id = "e1", name = "Pilot", type = "episode", season = 1, episode = 1),
    )
    api.remoteItemValues["rlibA:s1"] = RemoteItemDetailDto(
      RemoteItemDto(
        id = "s1",
        name = "The Show",
        type = "series",
        providerIds = RemoteProviderIdsDto(imdb = "tt1234567"),
      ),
    )
    val item = RemoteItemDto(
      id = "e1",
      name = "Pilot",
      type = "episode",
      season = 1,
      episode = 1,
      seriesId = "s1",
      providerIds = RemoteProviderIdsDto(imdb = "tt7654321"),
    )

    val resolved = resolveRemoteMetadata(api, data(item))

    assertEquals("The Show", resolved.seriesName)
    assertEquals("tt1234567", resolved.seriesIds?.imdb)
    assertEquals(listOf("rlibA" to "s1"), api.remoteItemRequests)
  }

  @Test
  fun `a season follows its parent series rather than treating the season as a show`() = runTest {
    val api = FakeTvApi()
    api.remoteItemValues["rlibA:sea2"] = RemoteItemDetailDto(
      RemoteItemDto(id = "sea2", name = "Season 2", type = "season", seriesId = "show7"),
    )
    api.remoteItemValues["rlibA:show7"] = RemoteItemDetailDto(
      RemoteItemDto(id = "show7", name = "Seven Days", type = "series", providerIds = RemoteProviderIdsDto(tmdb = "77")),
    )

    val resolved = resolveRemoteMetadata(
      api,
      data(RemoteItemDto(id = "sea2", name = "Season 2", type = "season")),
    )

    assertEquals("Seven Days", resolved.seriesName)
    assertEquals("77", resolved.seriesIds?.tmdb)
    assertEquals(listOf("rlibA" to "sea2", "rlibA" to "show7"), api.remoteItemRequests)
  }

  @Test
  fun `a mismatched caller hint never overrides the episode's authoritative parent`() = runTest {
    val api = FakeTvApi()
    api.remoteItemValues["rlibA:show-right"] = RemoteItemDetailDto(
      RemoteItemDto(
        id = "show-right",
        name = "Right Show",
        type = "series",
        providerIds = RemoteProviderIdsDto(imdb = "tt0000002"),
      ),
    )
    val episode = RemoteItemDto(
      id = "e1",
      name = "Episode",
      type = "episode",
      seriesId = "show-right",
      season = 7,
      episode = 1,
    )

    val resolved = resolveRemoteMetadata(
      api,
      data(
        episode,
        seriesName = "Wrong Show",
        seriesIds = RemoteProviderIdsDto(imdb = "tt0000001"),
      ),
    )

    assertEquals("Right Show", resolved.seriesName)
    assertEquals("tt0000002", resolved.seriesIds?.imdb)
    assertEquals(listOf("rlibA" to "show-right"), api.remoteItemRequests)
  }

  @Test
  fun `an episode without a parent identity performs no guessed parent lookup`() = runTest {
    val api = FakeTvApi()
    api.remoteItemValues["rlibA:e1"] = RemoteItemDetailDto(
      RemoteItemDto(id = "e1", name = "Unknown episode", type = "episode", season = 3, episode = 7),
    )
    val item = RemoteItemDto(
      id = "e1",
      name = "Unknown episode",
      type = "episode",
      season = 3,
      episode = 7,
      providerIds = RemoteProviderIdsDto(imdb = "tt-episode-only"),
    )

    val resolved = resolveRemoteMetadata(api, data(item))

    assertNull(resolved.seriesIds)
    assertNull(resolved.seriesName)
    assertEquals(listOf("rlibA" to "e1"), api.remoteItemRequests)
  }

  @Test
  fun `a canceled older A read cannot publish after B when the fake ignores cancellation`() = runTest {
    val gate = CompletableDeferred<Unit>()
    val api = object : FakeTvApi() {
      override suspend fun remoteItem(libraryId: String, itemId: String): RemoteItemDetailDto {
        remoteItemRequests += libraryId to itemId
        withContext(NonCancellable) { gate.await() }
        return RemoteItemDetailDto(
          RemoteItemDto(
            id = itemId,
            name = "Late A",
            type = "movie",
            providerIds = RemoteProviderIdsDto(imdb = "tt-late-a"),
          ),
        )
      }
    }
    var published: RemoteMetadata? = null
    val job = launch {
      published = resolveRemoteMetadata(api, data(RemoteItemDto(id = "a", name = "A", type = "")))
    }
    runCurrent()
    job.cancel()
    gate.complete(Unit)
    runCurrent()

    assertNull(published)
  }
  @Test
  fun `a failed parent read keeps the explicit known series identity`() = runTest {
    val api = FakeTvApi()
    val ids = RemoteProviderIdsDto(imdb = "tt1234567")
    val resolved = resolveRemoteMetadata(api, data(
      RemoteItemDto(id = "e1", type = "episode", seriesId = "s1", season = 1, episode = 1),
      seriesName = "Known show", seriesIds = ids,
    ))
    assertEquals(ids, resolved.seriesIds)
    assertEquals("Known show", resolved.seriesName)
  }

  @Test
  fun `a parent without external ids keeps the explicit identity and updates its name`() = runTest {
    val api = FakeTvApi()
    api.remoteItemValues["rlibA:s1"] = RemoteItemDetailDto(RemoteItemDto(id = "s1", type = "series", name = "Current name"))
    val ids = RemoteProviderIdsDto(imdb = "tt1234567")
    val resolved = resolveRemoteMetadata(api, data(
      RemoteItemDto(id = "e1", type = "episode", seriesId = "s1", season = 1, episode = 1),
      seriesName = "Known show", seriesIds = ids,
    ))
    assertEquals(ids, resolved.seriesIds)
    assertEquals("Current name", resolved.seriesName)
  }

}
