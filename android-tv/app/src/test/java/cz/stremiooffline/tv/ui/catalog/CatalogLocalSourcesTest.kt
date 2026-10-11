@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.BehaviorHintsDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.ProgressEntryDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.StreamSourceDto
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Library copies offered as Local catalogue sources, the TV side of the web's local rows. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class CatalogLocalSourcesTest {

  @get:Rule val compose = createComposeRule()

  private val played = mutableListOf<PlayTarget>()
  private val shownInLibrary = mutableListOf<String>()

  private fun settings() = SettingsResponse(uiLanguage = "en", audioLanguage = "en", streamSort = "recommended", realDebridConfigured = true)

  private fun source(key: String) = StreamSourceDto(key, key.replaceFirstChar { it.uppercase() })

  private fun stream(sourceId: String, title: String, addonName: String) =
    StreamDto(sourceId = sourceId, kind = "remote", playable = true, title = title, addonName = addonName)

  private fun local(path: String = "Filmy/Heat (1995)/Heat.mkv", name: String = "Heat.mkv", library: String = "Filmy") =
    StreamDto(
      sourceId = "lib1",
      kind = "library",
      playable = true,
      localPath = path,
      libraryName = library,
      behaviorHints = BehaviorHintsDto(filename = name),
    )

  private fun movieArgs() = CatalogDetailArgs(MetaDto(id = "tt1", type = "movie", name = "It", poster = "poster.jpg"), "Cinemeta", "movie")

  private fun mount(api: FakeTvApi, args: CatalogDetailArgs = movieArgs(), onSources: (OfferedSources) -> Unit = {}) {
    compose.setContent {
      CatalogDetailScreen(
        api = api,
        args = args,
        imageUrl = { null },
        onPlay = { played += it },
        onBack = {},
        onSources = onSources,
        onShowInLibrary = { shownInLibrary += it },
      )
    }
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun focused(tag: String): Boolean =
    compose.onAllNodes(isFocused()).fetchSemanticsNodes()
      .any { it.config.getOrElse(SemanticsProperties.TestTag) { "" } == tag }

  private fun focusFromLeft(tag: String) {
    repeat(6) {
      if (focused(tag)) return
      press(Key.DirectionRight)
    }
    compose.onNodeWithTag(tag).assertIsFocused()
  }

  private fun openSources() {
    focusFromLeft(TagCatalogSources)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSourcesPanel).assertExists()
  }

  @Test
  fun `the local row is row 0 and the focused default when the panel opens`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamSourcesValues["movie:tt1"] = listOf(source("alpha"))
    api.addonStreams["movie:tt1|alpha"] = listOf(stream("srcA", "Czech 8 GB", "Alpha"))
    api.localStreamsResult = listOf(local())
    mount(api)
    compose.waitForIdle()

    openSources()

    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()
    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText("Local"))
    compose.onNodeWithTag(sourceRowTag(1)).assert(hasText("Alpha"))
    compose.onNodeWithTag(TagCatalogSources).assertTextContains("Sources · 2")
  }

  @Test
  fun `OK on Play with a local default plays the file as a library target`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamSourcesValues["movie:tt1"] = listOf(source("alpha"))
    api.addonStreams["movie:tt1|alpha"] = listOf(stream("srcA", "Czech 8 GB", "Alpha"))
    api.localStreamsResult = listOf(local())
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
    press(Key.DirectionCenter)

    val target = played.single()
    assertEquals("Filmy/Heat (1995)/Heat.mkv", target.path)
    assertEquals("file:Filmy/Heat (1995)/Heat.mkv", target.key)
    assertNull(target.sourceId)
    assertNull(target.subtitleTarget)
  }

  @Test
  fun `saved file progress with no catalogue progress resumes on Play and Start over starts from zero`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.localStreamsResult = listOf(local())
    api.progressValues["file:Filmy/Heat (1995)/Heat.mkv"] = ProgressDto(position = 40.0, duration = 120.0)
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogStartOver).assertExists()
    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
    press(Key.DirectionCenter)
    assertEquals(true, played.single().resume)

    focusFromLeft(TagCatalogStartOver)
    press(Key.DirectionCenter)
    assertEquals(false, played.last().resume)
    assertEquals("Filmy/Heat (1995)/Heat.mkv", played.last().path)
    assertEquals("file:Filmy/Heat (1995)/Heat.mkv", played.last().key)
  }

  @Test
  fun `To library is absent and Show in library opens the file's folder`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.localStreamsResult = listOf(local())
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogToLibrary).assertDoesNotExist()
    compose.onNodeWithTag(TagCatalogShowInLibrary).assertExists()

    focusFromLeft(TagCatalogShowInLibrary)
    press(Key.DirectionCenter)

    assertEquals(listOf("Filmy/Heat (1995)"), shownInLibrary)
    assertEquals(0, api.downloadCalls)
  }

  @Test
  fun `a failing streamSources still loads and plays the local row`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamSourcesFailures["movie:tt1"] = ApiFailure.Unreachable
    api.localStreamsResult = listOf(local())
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
    press(Key.DirectionCenter)

    assertEquals("Filmy/Heat (1995)/Heat.mkv", played.single().path)
  }

  @Test
  fun `a failing localStreams leaves the addon rows and plays the addon default`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamSourcesValues["movie:tt1"] = listOf(source("alpha"))
    api.addonStreams["movie:tt1|alpha"] = listOf(stream("srcA", "Czech 8 GB", "Alpha"))
    api.localStreamsError = ApiError(ApiFailure.Unreachable)
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
    press(Key.DirectionCenter)

    assertEquals("srcA", played.single().sourceId)
  }

  @Test
  fun `a late local answer after every addon moves an automatic addon pick to local`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamSourcesValues["movie:tt1"] = listOf(source("alpha"))
    api.addonStreams["movie:tt1|alpha"] = listOf(stream("srcA", "Czech 8 GB", "Alpha"))
    api.localStreamsResult = listOf(local())
    val gate = CompletableDeferred<Unit>()
    api.localStreamsGate = gate
    mount(api)
    compose.waitUntil(5_000) { api.localStreamsRequests.contains("movie:tt1") }
    compose.waitUntil(5_000) { api.streamsCompleted.contains("movie:tt1|alpha") }
    compose.waitForIdle()

    // The addon is the automatic pick while the local answer is still out; the late local copy
    // must replace it (the web's `upgrade` repick) so it becomes the selected default.
    gate.complete(Unit)
    compose.waitForIdle()
    openSources()

    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText("Local"))
    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText("Heat.mkv"))
    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText("✓ Default", substring = true))
    compose.onNodeWithTag(sourceRowTag(1)).assert(hasText("Alpha"))
    assertTrue(played.isEmpty())
  }

  @Test
  fun `a late local answer never replaces an addon row the viewer picked`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamSourcesValues["movie:tt1"] = listOf(source("alpha"))
    api.addonStreams["movie:tt1|alpha"] = listOf(stream("srcA", "Czech 8 GB", "Alpha"))
    api.localStreamsResult = listOf(local())
    val gate = CompletableDeferred<Unit>()
    api.localStreamsGate = gate
    mount(api)
    compose.waitUntil(5_000) { api.streamsCompleted.contains("movie:tt1|alpha") }
    compose.waitForIdle()

    openSources()
    // The only row is the addon; pick it while the local answer is still out.
    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()
    press(Key.DirectionCenter)
    assertTrue(played.isEmpty())

    gate.complete(Unit)
    compose.waitForIdle()
    press(Key.DirectionCenter)

    assertEquals("srcA", played.single().sourceId)
    assertNull(played.single().path)
  }

  @Test
  fun `switching episode ignores a stale gated local answer`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    val v1 = VideoDto(id = "tt1:1:1", title = "One", season = 1, episode = 1)
    val v2 = VideoDto(id = "tt1:1:2", title = "Two", season = 1, episode = 2)
    api.metaValues["series:tt1"] = MetaDto(id = "tt1", type = "series", name = "Show", videos = listOf(v1, v2))
    api.streamSourcesValues["series:tt1:1:1"] = listOf(source("alpha"))
    api.addonStreams["series:tt1:1:1|alpha"] = listOf(stream("src1", "Czech 1 GB", "Alpha"))
    api.streamSourcesValues["series:tt1:1:2"] = listOf(source("alpha"))
    api.addonStreams["series:tt1:1:2|alpha"] = listOf(stream("src2", "Czech 1 GB", "Alpha"))
    api.localStreamsValues["series:tt1:1:1"] = listOf(local(path = "Filmy/Show/STALE.mkv", name = "STALE.mkv"))
    api.localStreamsValues["series:tt1:1:2"] = emptyList()
    val gate = CompletableDeferred<Unit>()
    api.localStreamsGate = gate
    mount(api, CatalogDetailArgs(MetaDto(id = "tt1", type = "series", name = "Show"), "Cinemeta", "series"))
    compose.waitUntil(5_000) { api.localStreamsRequests.contains("series:tt1:1:1") }
    compose.waitUntil(5_000) { api.streamsCompleted.contains("series:tt1:1:1|alpha") }
    compose.waitForIdle()

    focusFromLeft(TagCatalogPrimary)
    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
    press(Key.DirectionDown)
    compose.onNodeWithTag(episodeCardTag(v1)).assertIsFocused()
    press(Key.DirectionRight)
    compose.onNodeWithTag(episodeCardTag(v2)).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitForIdle()
    runCatching { compose.waitUntil(2_000) { api.localStreamsRequests.contains("series:tt1:1:2") } }
    assertEquals(listOf("series:tt1:1:1", "series:tt1:1:2"), api.localStreamsRequests)

    // The stale episode-one local answer lands now; it belongs to a request nobody is waiting for.
    gate.complete(Unit)
    compose.waitForIdle()

    openSources()
    compose.onNodeWithTag(TagSourcesPanel).assertExists()
    compose.onAllNodes(hasText("STALE.mkv"), useUnmergedTree = true).assertCountEquals(0)
  }
}
