@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performSemanticsAction
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.RemoteCapabilitiesDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteItemStateDto
import cz.stremiooffline.tv.data.RemotePersonalPage
import cz.stremiooffline.tv.data.RemoteItemsPageDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.TitleRefDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import cz.stremiooffline.tv.ui.detail.RemoteDetailData
import cz.stremiooffline.tv.ui.shell.remoteFallbackCatalogueArgs
import cz.stremiooffline.tv.ui.shell.remoteOwnCatalogueArgs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class CatalogOwnRemoteTest {

  @get:Rule val compose = createComposeRule()

  private val played = mutableListOf<PlayTarget>()

  private fun remote(
    libraryId: String,
    itemId: String,
    mediaSourceId: String = "source-$itemId",
    canDownload: Boolean = false,
  ) = StreamDto(
    sourceId = "remote:$itemId:$mediaSourceId",
    kind = "remote",
    playable = true,
    name = mediaSourceId,
    provider = "jellyfin",
    libraryName = "Library",
    remoteItem = RemoteItemContext(
      libraryId = libraryId,
      itemId = itemId,
      mediaSourceId = mediaSourceId,
      progressKey = "remote:$libraryId:$itemId",
    ),
    capabilities = RemoteCapabilitiesDto(downloadToLibrary = canDownload),
  )

  private fun mount(api: FakeTvApi, args: CatalogDetailArgs) {
    compose.setContent {
      CatalogDetailScreen(
        api = api,
        args = args,
        imageUrl = { null },
        onPlay = { played += it },
        onBack = {},
      )
    }
  }

  @Test
  fun `an id-less remote film stays remote through play favourite and watched`() {
    val film = RemoteItemDto(id = "film", name = "Heat", type = "movie")
    val api = FakeTvApi().apply {
      remoteSourcesValue = listOf(
        remote("library", "film", "source-one"),
        remote("library", "film", "source-two"),
      )
      remoteStateValue = RemoteItemStateDto(
        position = 30.0,
        duration = 100.0,
        mediaSourceId = "source-two",
      )
    }
    val args = remoteOwnCatalogueArgs(
      RemoteDetailData("library", "Library", "jellyfin", film),
      film,
      emptyList(),
      emptyList(),
    )
    mount(api, args)
    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(TagCatalogMarkWatched).assertExists() }.isSuccess
    }

    assertTrue(api.metaRequests.isEmpty())
    assertTrue(api.streamSourcesRequests.isEmpty())
    assertTrue(api.streamsRequests.isEmpty())
    assertTrue(api.remoteMatchRequests.isEmpty())
    assertTrue(api.progressRequests.isEmpty())

    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(TagCatalogPrimary).assertTextContains("Resume") }.isSuccess
    }
    compose.onNodeWithTag(TagCatalogPrimary).performSemanticsAction(SemanticsActions.OnClick)
    compose.waitUntil(5_000) { played.isNotEmpty() }
    assertEquals("film", played.single().remoteItem?.itemId)
    assertEquals("source-two", played.single().remoteItem?.mediaSourceId)
    assertEquals("remote:library:film", played.single().key)
    assertEquals(null, played.single().subtitleTarget)

    compose.onNodeWithTag(TagCatalogFavourite).performSemanticsAction(SemanticsActions.OnClick)
    compose.waitUntil(5_000) { api.remoteStatePatchRequests.any { it.third.favorite == true } }
    assertEquals("film", api.remoteStatePatchRequests.first { it.third.favorite == true }.second)

    compose.onNodeWithTag(TagCatalogMarkWatched).performSemanticsAction(SemanticsActions.OnClick)
    compose.waitUntil(5_000) { api.remoteStatePatchRequests.any { it.third.watched == true } }
    assertEquals("film", api.remoteStatePatchRequests.first { it.third.watched == true }.second)
    assertTrue(api.progressRequests.none { it.startsWith("remote:") })
  }

  @Test
  fun `selecting an id-less series episode reads that episode's remote versions`() {
    val show = RemoteItemDto(id = "show", name = "Show", type = "series")
    val first = RemoteItemDto(id = "e1", name = "One", type = "episode", seriesId = "show", season = 1, episode = 1)
    val second = RemoteItemDto(id = "e2", name = "Two", type = "episode", seriesId = "show", season = 1, episode = 2)
    val api = FakeTvApi().apply {
      remoteSourcesValue = listOf(remote("library", "e1"))
      remotePersonalValue = RemotePersonalPage(emptyList(), 0, false)
    }
    val args = remoteOwnCatalogueArgs(
      RemoteDetailData("library", "Library", "jellyfin", show),
      show,
      listOf(first, second),
      emptyList(),
    )
    mount(api, args)
    compose.waitUntil(5_000) { api.remoteSourcesRequests.contains("library" to "e1") }

    compose.onNodeWithTag(episodeCardTag(args.meta.videos.orEmpty().last())).performSemanticsAction(SemanticsActions.OnClick)
    compose.waitUntil(5_000) { api.remoteSourcesRequests.contains("library" to "e2") }

    assertTrue(api.metaRequests.isEmpty())
    assertTrue(api.streamSourcesRequests.isEmpty())
    assertTrue(api.remoteMatchRequests.isEmpty())
    assertTrue(api.progressRequests.isEmpty())
  }

  @Test
  fun `a failed remote favourite reverts the star and shows the failure`() {
    val film = RemoteItemDto(id = "film", name = "Heat", type = "movie")
    val api = FakeTvApi().apply {
      remoteSourcesValue = listOf(remote("library", "film"))
      remoteStatePatchFailure = ApiError(ApiFailure.Generic)
    }
    val args = remoteOwnCatalogueArgs(
      RemoteDetailData("library", "Library", "jellyfin", film),
      film,
      emptyList(),
      emptyList(),
    )
    mount(api, args)
    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(TagCatalogFavourite).assertTextContains("☆") }.isSuccess
    }

    compose.onNodeWithTag(TagCatalogFavourite).performSemanticsAction(SemanticsActions.OnClick)

    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(TagCatalogMessage).assertTextContains("Something went wrong. Try again.") }.isSuccess
    }
    compose.onNodeWithTag(TagCatalogFavourite).assertTextContains("☆")
    compose.onNodeWithTag(TagCatalogMessage)
      .assert(SemanticsMatcher.expectValue(CatalogNoticeKind, CatalogNotice.Failure))
  }

  @Test
  fun `a failed remote Mark as unwatched keeps the position and shows the failure`() {
    val film = RemoteItemDto(id = "film", name = "Heat", type = "movie")
    val api = FakeTvApi().apply {
      remoteSourcesValue = listOf(remote("library", "film", "source-one"))
      remoteStateValue = RemoteItemStateDto(
        position = 30.0,
        duration = 100.0,
        favorite = true,
        mediaSourceId = "source-one",
      )
      remoteStatePatchFailure = ApiError(ApiFailure.Generic)
    }
    val args = remoteOwnCatalogueArgs(
      RemoteDetailData("library", "Library", "jellyfin", film),
      film,
      emptyList(),
      emptyList(),
    )
    mount(api, args)
    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(TagCatalogForget).assertExists() }.isSuccess
    }

    compose.onNodeWithTag(TagCatalogForget).performSemanticsAction(SemanticsActions.OnClick)
    compose.onNodeWithTag(TagCatalogForgetRemove).performSemanticsAction(SemanticsActions.OnClick)

    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(TagCatalogMessage).assertTextContains("Something went wrong. Try again.") }.isSuccess
    }
    compose.onNodeWithTag(TagCatalogWatched).assertTextContains("30 % watched")
    compose.onNodeWithTag(TagCatalogForget).assertExists()
    compose.onNodeWithTag(TagCatalogFavourite).assertTextContains("★")
  }

  @Test
  fun `failed series episodes show the catalogue retry and load the resumed episode`() {
    val show = RemoteItemDto(id = "show", name = "Show", type = "series")
    val first = RemoteItemDto(id = "e1", name = "One", type = "episode", seriesId = "show", season = 1, episode = 1)
    val second = RemoteItemDto(id = "e2", name = "Two", type = "episode", seriesId = "show", season = 1, episode = 2)
    val api = FakeTvApi().apply {
      remoteEpisodesPages["show|"] = RemoteItemsPageDto(items = listOf(first, second), total = 2)
      remoteItemsFailure = ApiError(ApiFailure.Generic)
      remotePersonalValue = RemotePersonalPage(
        items = listOf(
          HomeCard.Remote(
            key = "resume",
            libraryId = "library",
            itemId = "e2",
            itemType = "episode",
            season = 1,
            episode = 2,
            identity = TitleRefDto(type = "series", id = "show"),
          ),
        ),
        total = 1,
        partial = false,
      )
    }
    mount(api, remoteFallbackCatalogueArgs(RemoteDetailData("library", "Library", "jellyfin", show)))

    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(TagCatalogMessage).assertTextContains("The library could not be loaded.") }.isSuccess
    }
    compose.onNodeWithTag(TagCatalogSources).performSemanticsAction(SemanticsActions.OnClick)
    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(TagCatalogRetry).assertExists() }.isSuccess
    }

    api.remoteItemsFailure = null
    compose.onNodeWithTag(TagCatalogRetry).performSemanticsAction(SemanticsActions.OnClick)

    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(TagCatalogEpisode).assertTextContains("S1 · E2 · Two") }.isSuccess
    }
    assertTrue(api.remoteEpisodesRequests.size >= 2)
  }

  @Test
  fun `a remote version without the native right offers no To library`() {
    val film = RemoteItemDto(id = "film", name = "Heat", type = "movie")
    val api = FakeTvApi().apply {
      remoteSourcesValue = listOf(remote("library", "film"))
      librariesValue = listOf(LibraryDto(id = "libA", name = "Films", type = "movie", writable = true))
    }
    val args = remoteOwnCatalogueArgs(
      RemoteDetailData("library", "Library", "jellyfin", film),
      film,
      emptyList(),
      emptyList(),
    )
    mount(api, args)
    compose.waitUntil(5_000) { api.remoteSourcesRequests.isNotEmpty() }

    compose.onNodeWithTag(TagCatalogToLibrary).assertDoesNotExist()
  }

  @Test
  fun `a local copy of a remote title is never offered for copying`() {
    val backend = RemoteBackend(
      libraryId = "library",
      libraryName = "Library",
      provider = "jellyfin",
      item = RemoteItemDto(id = "film", name = "Heat", type = "movie"),
    )
    val local = StreamDto(
      sourceId = "library-source",
      kind = "library",
      playable = true,
      localPath = "Films/Heat/Heat.mkv",
    )

    assertNull(backend.toLibrary(local))
  }

  @Test
  fun `To library queues exactly the picked remote version into the chosen library`() {
    val film = RemoteItemDto(id = "film", name = "Heat", type = "movie")
    val first = remote("library", "film", "source-one", canDownload = true)
    val second = remote("library", "film", "source-two", canDownload = true)
    val api = FakeTvApi().apply {
      remoteSourcesValue = listOf(first, second)
      librariesValue = listOf(LibraryDto(id = "libA", name = "Films", type = "movie", writable = true))
    }
    val args = remoteOwnCatalogueArgs(
      RemoteDetailData("library", "Library", "jellyfin", film),
      film,
      emptyList(),
      emptyList(),
    )
    mount(api, args)
    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(TagCatalogToLibrary).assertExists() }.isSuccess
    }

    compose.onNodeWithTag(TagCatalogToLibrary).performSemanticsAction(SemanticsActions.OnClick)
    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(nativeQueueVersionTag(second.sourceId)).assertExists() }.isSuccess
    }
    compose.onNodeWithTag(nativeQueueVersionTag(second.sourceId)).performSemanticsAction(SemanticsActions.OnClick)
    compose.onNodeWithTag(nativeQueueLibraryTag("libA")).performSemanticsAction(SemanticsActions.OnClick)

    compose.waitUntil(5_000) { api.queuedSourceIds.isNotEmpty() }
    assertEquals(listOf(second.sourceId), api.queuedSourceIds)
    assertEquals("libA", api.queuedTargets.single()?.libraryId)
  }
}
