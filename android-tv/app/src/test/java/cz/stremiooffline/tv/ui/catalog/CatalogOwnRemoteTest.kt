@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performSemanticsAction
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteItemStateDto
import cz.stremiooffline.tv.data.RemotePersonalPage
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import cz.stremiooffline.tv.ui.detail.RemoteDetailData
import cz.stremiooffline.tv.ui.shell.remoteOwnCatalogueArgs
import org.junit.Assert.assertEquals
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

  private fun remote(libraryId: String, itemId: String, mediaSourceId: String = "source-$itemId") = StreamDto(
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
}
