@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import cz.stremiooffline.tv.catalog.ResumeEpisode
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.BehaviorHintsDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class CatalogOwnTitleTest {

  @get:Rule val compose = createComposeRule()

  private val played = mutableListOf<PlayTarget>()

  private fun row(path: String) = StreamDto(
    sourceId = "file:$path",
    kind = "library",
    playable = true,
    name = path.substringAfterLast('/'),
    localPath = path,
    behaviorHints = BehaviorHintsDto(filename = path.substringAfterLast('/')),
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
  fun `an own-title film uses only its local data and actions`() {
    val path = "Films/Heat/Heat.mkv"
    val api = FakeTvApi().apply {
      progressValues["file:$path"] = ProgressDto(position = 30.0, duration = 100.0)
    }
    val args = CatalogDetailArgs(
      meta = MetaDto(
        id = "local:Films/Heat",
        type = "movie",
        name = "Heat",
        poster = "poster.jpg",
        background = "backdrop.jpg",
        description = "A film",
        releaseInfo = "1995",
      ),
      addonName = "",
      type = "movie",
      backend = LibraryBackend(
        rows = mapOf("local:Films/Heat" to listOf(row(path))),
        favouritePath = "Films/Heat",
        favourite = false,
      ),
    )
    mount(api, args)
    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(TagCatalogMarkWatched).assertExists() }.isSuccess
    }

    assertTrue(api.metaRequests.isEmpty())
    assertTrue(api.streamSourcesRequests.isEmpty())
    assertTrue(api.streamsRequests.isEmpty())
    assertTrue(api.remoteLibrariesCalls == 0)
    assertTrue(api.remoteMatchRequests.isEmpty())
    assertTrue(api.titleExtrasRequests.isEmpty())
    assertTrue(api.watchlistCalls == 0)
    assertTrue(api.localStreamsRequests.isEmpty())
    assertTrue(api.settingsCalls == 0)
    assertTrue(api.addonsCalls == 0)
    assertTrue(api.librariesCalls == 0)
    assertTrue(api.progressListCalls == 0)
    assertTrue(api.progressRequests.isNotEmpty())
    assertTrue(api.progressRequests.all { it == "file:$path" })
    compose.onNodeWithText("Resume").assertExists()
    compose.onNodeWithTag(TagCatalogStartOver).assertExists()
    compose.onNodeWithTag(TagCatalogToLibrary).assertDoesNotExist()

    compose.onNodeWithTag(TagCatalogPrimary).performSemanticsAction(SemanticsActions.OnClick)
    compose.waitUntil(5_000) { played.isNotEmpty() }
    assertEquals(path, played.single().path)
    assertEquals("file:$path", played.single().key)

    compose.onNodeWithTag(TagCatalogFavourite).performSemanticsAction(SemanticsActions.OnClick)
    compose.waitUntil(5_000) { api.libraryFavoriteCalls.isNotEmpty() }
    assertEquals(listOf("Films/Heat" to true), api.libraryFavoriteCalls)
    assertTrue(api.favoriteCalls.isEmpty())

    compose.onNodeWithTag(TagCatalogMarkWatched).performSemanticsAction(SemanticsActions.OnClick)
    compose.waitUntil(5_000) { api.progressSaves.isNotEmpty() }
    val saved = api.progressSaves.single()
    assertEquals("file:$path", saved.key)
    assertEquals(path, saved.path)
    assertTrue(saved.final)
    assertEquals(1.0, saved.position, 0.0)
  }

  @Test
  fun `a failed library favourite keeps the star and shows the failure`() {
    val path = "Films/Heat/Heat.mkv"
    val api = FakeTvApi().apply { favoriteFailure = ApiFailure.Generic }
    val args = CatalogDetailArgs(
      meta = MetaDto(id = "local:Films/Heat", type = "movie", name = "Heat"),
      addonName = "",
      type = "movie",
      backend = LibraryBackend(
        rows = mapOf("local:Films/Heat" to listOf(row(path))),
        favouritePath = "Films/Heat",
        favourite = false,
      ),
    )
    mount(api, args)
    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(TagCatalogMarkWatched).assertExists() }.isSuccess
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
  fun `a failed library Mark watched keeps the position and shows the failure`() {
    val path = "Films/Heat/Heat.mkv"
    val api = FakeTvApi().apply {
      progressValues["file:$path"] = ProgressDto(position = 30.0, duration = 100.0)
      progressSaveFailure = ApiFailure.Generic
    }
    val args = CatalogDetailArgs(
      meta = MetaDto(id = "local:Films/Heat", type = "movie", name = "Heat"),
      addonName = "",
      type = "movie",
      backend = LibraryBackend(
        rows = mapOf("local:Films/Heat" to listOf(row(path))),
        favouritePath = "Films/Heat",
        favourite = false,
      ),
    )
    mount(api, args)
    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(TagCatalogMarkWatched).assertExists() }.isSuccess
    }

    compose.onNodeWithTag(TagCatalogMarkWatched).performSemanticsAction(SemanticsActions.OnClick)

    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(TagCatalogMessage).assertTextContains("Something went wrong. Try again.") }.isSuccess
    }
    compose.onNodeWithTag(TagCatalogPrimary).assertTextContains("Resume")
    compose.onNodeWithTag(TagCatalogStartOver).assertExists()
    assertTrue(api.progressSaves.isEmpty())
  }

  @Test
  fun `a failed library forget keeps the position and favourite and shows the failure`() {
    val path = "Films/Heat/Heat.mkv"
    val api = FakeTvApi().apply {
      progressValues["file:$path"] = ProgressDto(position = 30.0, duration = 100.0)
      forgetFailure = ApiFailure.Generic
    }
    val args = CatalogDetailArgs(
      meta = MetaDto(id = "local:Films/Heat", type = "movie", name = "Heat"),
      addonName = "",
      type = "movie",
      backend = LibraryBackend(
        rows = mapOf("local:Films/Heat" to listOf(row(path))),
        favouritePath = "Films/Heat",
        favourite = true,
      ),
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
    compose.onNodeWithTag(TagCatalogPrimary).assertTextContains("Resume")
    compose.onNodeWithTag(TagCatalogWatched).assertTextContains("30 % watched")
    compose.onNodeWithTag(TagCatalogFavourite).assertTextContains("★")
    assertEquals(listOf("file:$path"), api.forgetCalls.single())
  }

  @Test
  fun `an own-title series shows and plays the chosen episode`() {
    val first = "Shows/Show/Show.S01E01.mkv"
    val second = "Shows/Show/Show.S01E02.mkv"
    val firstVideo = VideoDto(id = "local:$first", season = 1, episode = 1, title = "Pilot")
    val secondVideo = VideoDto(id = "local:$second", season = 1, episode = 2, title = "Second")
    val api = FakeTvApi()
    val args = CatalogDetailArgs(
      meta = MetaDto(
        id = "local:Shows/Show",
        type = "series",
        name = "Show",
        videos = listOf(firstVideo, secondVideo),
      ),
      addonName = "",
      type = "series",
      episode = ResumeEpisode("series:local:$second", 1, 2),
      backend = LibraryBackend(
        rows = mapOf(
          "local:$first" to listOf(row(first)),
          "local:$second" to listOf(row(second)),
        ),
        favouritePath = "Shows/Show",
        favourite = true,
      ),
    )
    mount(api, args)
    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(TagCatalogMarkWatched).assertExists() }.isSuccess
    }

    compose.onNodeWithTag(seasonChipTag(1)).assertExists()
    compose.onNodeWithTag(episodeCardTag(secondVideo)).assertExists()
    compose.onNodeWithTag(TagCatalogFavourite).assertTextContains("★")
    compose.onNodeWithTag(TagCatalogToLibrary).assertDoesNotExist()
    assertTrue(api.progressRequests.isNotEmpty())
    assertTrue(api.progressRequests.all { it == "file:$second" })
    compose.onNodeWithTag(TagCatalogPrimary).performSemanticsAction(SemanticsActions.OnClick)
    compose.waitUntil(5_000) { played.isNotEmpty() }
    assertEquals(second, played.single().path)
    assertEquals("file:$second", played.single().key)
  }

  @Test
  fun `Mark as unwatched on an own-title series clears only the selected episode`() {
    val first = "Shows/Show/Show.S01E01.mkv"
    val second = "Shows/Show/Show.S01E02.mkv"
    val firstVideo = VideoDto(id = "local:$first", season = 1, episode = 1, title = "Pilot")
    val secondVideo = VideoDto(id = "local:$second", season = 1, episode = 2, title = "Second")
    val api = FakeTvApi().apply {
      progressValues["file:$first"] = ProgressDto(position = 60.0, duration = 100.0)
      progressValues["file:$second"] = ProgressDto(position = 30.0, duration = 100.0)
    }
    val args = CatalogDetailArgs(
      meta = MetaDto(
        id = "local:Shows/Show",
        type = "series",
        name = "Show",
        videos = listOf(firstVideo, secondVideo),
      ),
      addonName = "",
      type = "series",
      episode = ResumeEpisode("series:local:$second", 1, 2),
      backend = LibraryBackend(
        rows = mapOf(
          "local:$first" to listOf(row(first)),
          "local:$second" to listOf(row(second)),
        ),
        favouritePath = "Shows/Show",
        favourite = false,
        progress = mapOf(
          "local:$first" to ProgressDto(position = 60.0, duration = 100.0),
          "local:$second" to ProgressDto(position = 30.0, duration = 100.0),
        ),
      ),
    )
    mount(api, args)
    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(TagCatalogForget).assertExists() }.isSuccess
    }

    compose.onNodeWithTag(TagCatalogForget).performSemanticsAction(SemanticsActions.OnClick)
    compose.onNodeWithTag(TagCatalogForgetRemove).performSemanticsAction(SemanticsActions.OnClick)

    compose.waitUntil(5_000) { api.forgetCalls.isNotEmpty() }
    assertEquals(listOf("file:$second"), api.forgetCalls.single())
  }

  @Test
  fun `an own series re-reads every episode's position for its card after the player`() = kotlinx.coroutines.runBlocking {
    val api = FakeTvApi().apply {
      progressValues["file:Show/E1.mkv"] = ProgressDto(position = 1200.0, duration = 1200.0)
      progressValues["file:Show/E2.mkv"] = ProgressDto(position = 300.0, duration = 1200.0)
    }
    val own = LibraryBackend(
      rows = mapOf(
        "local:Show/E1.mkv" to listOf(StreamDto(sourceId = "1", kind = "library", playable = true, localPath = "Show/E1.mkv")),
        "local:Show/E2.mkv" to listOf(StreamDto(sourceId = "2", kind = "library", playable = true, localPath = "Show/E2.mkv")),
      ),
      favouritePath = "Show",
      favourite = false,
      progress = mapOf("local:Show/E2.mkv" to ProgressDto(position = 10.0, duration = 1200.0)),
    )

    val fresh = refreshedOwnProgress(api, own, own.progress)

    assertTrue(ownEpisodeCompleted(fresh, "local:Show/E1.mkv"))
    assertEquals(0.25f, ownEpisodeProgress(fresh, "local:Show/E2.mkv")!!, 0.001f)
    assertEquals(null, ownEpisodeProgress(fresh, "local:Show/E3.mkv"))
  }
}
