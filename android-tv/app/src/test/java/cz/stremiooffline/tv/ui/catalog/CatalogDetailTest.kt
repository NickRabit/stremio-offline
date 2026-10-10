@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.Modifier
import androidx.compose.runtime.mutableIntStateOf
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.catalog.ResumeEpisode
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class CatalogDetailTest {

  @get:Rule val compose = createComposeRule()

  private val played = mutableListOf<PlayTarget>()

  private fun stream(
    sourceId: String,
    playable: Boolean = true,
    kind: String = "remote",
    name: String? = null,
    title: String? = null,
    addonName: String? = null,
  ) = StreamDto(sourceId = sourceId, kind = kind, playable = playable, name = name, title = title, addonName = addonName)

  private fun settings() = SettingsResponse(uiLanguage = "en", audioLanguage = "en", streamSort = "recommended", realDebridConfigured = true)

  private fun movieArgs() = CatalogDetailArgs(MetaDto(id = "tt1", type = "movie", name = "It", description = "A film", releaseInfo = "2017"), "Cinemeta", "movie")

  private fun mount(api: FakeTvApi, args: CatalogDetailArgs) {
    compose.setContent {
      CatalogDetailScreen(api = api, args = args, imageUrl = { null }, onPlay = { played += it }, onBack = {})
    }
  }

  // Every interaction goes through the remote: a key at the root reaches whatever holds focus.
  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun focused(tag: String): Boolean =
    compose.onAllNodes(isFocused()).fetchSemanticsNodes()
      .any { it.config.getOrElse(SemanticsProperties.TestTag) { "" } == tag }

  /** Walk right until the tag holds focus, the way a viewer pages across the action row. */
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
  fun `a movie shows Play focused and no Start over`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamsValues["movie:tt1"] = listOf(stream("s1", name = "FullHD"))
    mount(api, movieArgs())
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
    compose.onNodeWithText("Play").assertIsDisplayed()
    compose.onNodeWithTag(TagCatalogStartOver).assertDoesNotExist()
  }

  @Test
  fun `stored progress shows Resume and Start over`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamsValues["movie:tt1"] = listOf(stream("s1", name = "FullHD"))
    api.progressValues["movie:tt1"] = ProgressDto(38.6, 120.0)
    mount(api, movieArgs())
    compose.waitForIdle()

    compose.onNodeWithText("Resume").assertIsDisplayed()
    compose.onNodeWithTag(TagCatalogStartOver).assertExists()
  }

  @Test
  fun `To library is hidden when the only stream cannot be queued`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamsValues["movie:tt1"] = listOf(stream("s1", playable = false, name = "External"))
    mount(api, movieArgs())
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogToLibrary).assertDoesNotExist()
  }

  @Test
  fun `To library is shown for a playable stream`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamsValues["movie:tt1"] = listOf(stream("s1", name = "FullHD"))
    mount(api, movieArgs())
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogToLibrary).assertExists()
  }

  @Test
  fun `favourite toggles and calls the server`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamsValues["movie:tt1"] = listOf(stream("s1", name = "FullHD"))
    mount(api, movieArgs())
    compose.waitForIdle()

    focusFromLeft(TagCatalogFavourite)
    press(Key.DirectionCenter)

    assertEquals(listOf(Triple("movie", "tt1", true)), api.favoriteCalls)
  }

  @Test
  fun `sources open in arrangeStreams order, the default is marked and OK chooses it`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamsValues["movie:tt1"] = listOf(
      stream("srcA", name = "small", title = "Czech 1 GB", addonName = "alpha"),
      stream("srcB", name = "big", title = "Czech 8 GB", addonName = "beta"),
    )
    mount(api, movieArgs())
    compose.waitForIdle()

    openSources()
    compose.onNodeWithText("✓ Default").assertExists()
    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()
    compose.onNodeWithTag(sourceRowTag(1)).assertExists()

    // Recommended puts the largest first, so the ticked row is srcB and OK makes it the choice.
    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()
    press(Key.DirectionCenter)

    assertTrue(played.isEmpty())
    compose.onNodeWithTag(TagSourcesPanel).assertDoesNotExist()
    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()

    press(Key.DirectionCenter)
    assertEquals(listOf("srcB"), played.map { it.sourceId })
  }

  // Found on the owner's server: the panel opened but no row ever took focus.
  @Test
  fun `the sources panel takes the remote from the button behind it`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamsValues["movie:tt1"] = listOf(
      stream("srcA", name = "small", title = "Czech 1 GB"),
      stream("srcB", name = "big", title = "Czech 8 GB"),
    )
    mount(api, movieArgs())
    compose.waitForIdle()

    openSources()

    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()
    compose.onNodeWithTag(TagCatalogPrimary).assertIsNotFocused()
    press(Key.DirectionDown)
    compose.onNodeWithTag(sourceRowTag(1)).assertIsFocused()
    press(Key.DirectionCenter)

    // Choosing the row does not play it; the action row does, once the panel is gone.
    assertTrue(played.isEmpty())
    compose.onNodeWithTag(TagSourcesPanel).assertDoesNotExist()
    press(Key.DirectionCenter)
    assertEquals(listOf("srcA"), played.map { it.sourceId })
  }

  @Test
  fun `the background stays inert while a panel is open`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamsValues["movie:tt1"] = listOf(
      stream("srcA", name = "small", title = "Czech 1 GB"),
      stream("srcB", name = "big", title = "Czech 8 GB"),
    )
    mount(api, movieArgs())
    compose.waitForIdle()

    openSources()
    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()
    press(Key.DirectionLeft)

    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()
    compose.onNodeWithTag(TagCatalogPrimary).assertIsNotFocused()
  }

  @Test
  fun `no offered streams shows the empty text`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    mount(api, movieArgs())
    compose.waitForIdle()

    openSources()

    compose.onNodeWithText("No active source addon has a stream for this title.").assertExists()
  }

  @Test
  fun `play with no source says so`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    mount(api, movieArgs())
    compose.waitForIdle()

    press(Key.DirectionCenter)

    compose.onNodeWithText("No active source addon has a stream for this title.").assertExists()
  }

  @Test
  fun `a series focuses the next episode and reloads streams for the one chosen`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    val v1 = VideoDto(id = "tt1:1:1", title = "One", season = 1, episode = 1)
    val v2 = VideoDto(id = "tt1:1:2", title = "Two", season = 1, episode = 2)
    val v3 = VideoDto(id = "tt1:1:3", title = "Three", season = 1, episode = 3)
    api.metaValues["series:tt1"] = MetaDto(id = "tt1", type = "series", name = "Show", description = "A show", videos = listOf(v1, v2, v3))
    api.progressEntries = listOf(
      ProgressEntryDto(key = "series:tt1:1:1", position = 600.0, duration = 600.0, title = "Show · One", series = ProgressEntryDto.Series("tt1", "Show", 1, 1)),
    )
    api.streamsValues["series:tt1:1:2"] = listOf(stream("s2", name = "FullHD"))
    api.streamsValues["series:tt1:1:3"] = listOf(stream("s3", name = "FullHD"))
    mount(api, CatalogDetailArgs(MetaDto(id = "tt1", type = "series", name = "Show"), "Cinemeta", "series"))
    compose.waitForIdle()

    compose.onNodeWithTag(seasonChipTag(1)).assertExists()
    compose.onNodeWithTag(episodeCardTag(v2)).assertExists()
    compose.onNodeWithTag(episodeCardTag(v3)).assertExists()

    press(Key.DirectionDown)
    compose.onNodeWithTag(episodeCardTag(v2)).assertIsFocused()

    press(Key.DirectionRight)
    compose.onNodeWithTag(episodeCardTag(v3)).assertIsFocused()
    press(Key.DirectionCenter)
    assertTrue(api.streamsRequests.contains("series:tt1:1:3"))
  }

  // --- ATV-12: choosing a source, series sources, DOWN in the panel ---------------------------

  @Test
  fun `Down in series source panel reaches the second source`() {
    val api = seriesApi()
    api.metaValues["series:tt1"] = seriesMeta(v1(), v2())
    api.streamsValues["series:tt1:1:1"] = listOf(
      stream("srcA", name = "A", title = "English 8 GB"),
      stream("srcB", name = "B", title = "English 1 GB"),
    )
    mount(api, seriesArgs())
    compose.waitForIdle()

    openSources()
    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()
    press(Key.DirectionDown)
    compose.onNodeWithTag(sourceRowTag(1)).assertIsFocused()
  }

  @Test
  fun `DOWN from the action row still lands on the episodes`() {
    val api = seriesApi()
    api.metaValues["series:tt1"] = seriesMeta(v1(), v2())
    api.streamsValues["series:tt1:1:1"] = listOf(stream("s1", name = "One's source"))
    mount(api, seriesArgs())
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
    press(Key.DirectionDown)
    compose.onNodeWithTag(episodeCardTag(v1())).assertIsFocused()
  }

  @Test
  fun `OK on a source row chooses it, closes the panel and focuses Play`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamsValues["movie:tt1"] = listOf(
      stream("srcA", name = "small", title = "Czech 1 GB", addonName = "alpha"),
      stream("srcB", name = "big", title = "Czech 8 GB", addonName = "beta"),
    )
    mount(api, movieArgs())
    compose.waitForIdle()

    openSources()
    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()
    press(Key.DirectionDown)
    compose.onNodeWithTag(sourceRowTag(1)).assertIsFocused()
    press(Key.DirectionCenter)

    assertTrue(played.isEmpty())
    compose.onNodeWithTag(TagSourcesPanel).assertDoesNotExist()
    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
    compose.onNodeWithTag(TagCatalogChosenSource).assertTextContains("Source · alpha · small · 1.0 GB")
  }

  @Test
  fun `reopening the panel focuses and ticks the chosen row`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamsValues["movie:tt1"] = listOf(
      stream("srcA", name = "small", title = "Czech 1 GB", addonName = "alpha"),
      stream("srcB", name = "big", title = "Czech 8 GB", addonName = "beta"),
    )
    mount(api, movieArgs())
    compose.waitForIdle()

    openSources()
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    assertTrue(played.isEmpty())

    focusFromLeft(TagCatalogSources)
    press(Key.DirectionCenter)

    compose.onNodeWithTag(sourceRowTag(1)).assertIsFocused()
    compose.onNodeWithTag(sourceRowTag(0)).assertTextContains("Default", substring = true)
    compose.onNodeWithTag(sourceRowTag(1)).assertTextContains("✓", substring = true)
  }

  @Test
  fun `To library queues the chosen source`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamsValues["movie:tt1"] = listOf(
      stream("srcA", name = "small", title = "Czech 1 GB", addonName = "alpha"),
      stream("srcB", name = "big", title = "Czech 8 GB", addonName = "beta"),
    )
    mount(api, movieArgs())
    compose.waitForIdle()

    openSources()
    press(Key.DirectionDown)
    press(Key.DirectionCenter)

    focusFromLeft(TagCatalogToLibrary)
    press(Key.DirectionCenter)

    assertEquals(listOf("srcA"), api.queuedSourceIds)
    compose.onNodeWithTag(TagCatalogToLibrary).assertTextContains("Queued", substring = true)
  }

  @Test
  fun `a row that cannot be played or queued can still be chosen`() {
    val api = FakeTvApi()
    api.settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", realDebridConfigured = false)
    api.streamsValues["movie:tt1"] = listOf(
      stream("s1", playable = false, kind = "remote", name = "External", title = "Czech 8 GB", addonName = "alpha"),
    )
    mount(api, movieArgs())
    compose.waitForIdle()

    openSources()
    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()
    press(Key.DirectionCenter)

    assertTrue(played.isEmpty())
    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
    compose.onNodeWithTag(TagCatalogChosenSource).assertTextContains("Source · alpha · External · 8.0 GB")
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagCatalogMessage).assertTextContains("A torrent cannot be played directly.", substring = true)
  }

  @Test
  fun `a series asks for the preselected episode's sources on open`() {
    val api = seriesApi()
    api.metaValues["series:tt1"] = seriesMeta(v1(), v2())
    api.streamsValues["series:tt1:1:1"] = listOf(stream("s1", name = "One's source"))
    mount(api, seriesArgs())
    compose.waitForIdle()

    assertTrue(api.streamsRequests.contains("series:tt1:1:1"))
    assertFalse(api.streamsRequests.contains("series:tt1"))
    compose.onNodeWithTag(TagCatalogSources).assertTextContains("Sources · 1")
  }

  @Test
  fun `the episode line names the selected episode`() {
    val api = seriesApi()
    api.metaValues["series:tt1"] = seriesMeta(v1(), v2())
    api.streamsValues["series:tt1:1:1"] = listOf(stream("s1", name = "One's source"))
    api.streamsValues["series:tt1:1:2"] = listOf(stream("s2", name = "Two's source"))
    mount(api, seriesArgs())
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogEpisode).assertTextContains("S1 · E1 · One")

    press(Key.DirectionDown)
    compose.onNodeWithTag(episodeCardTag(v1())).assertIsFocused()
    press(Key.DirectionRight)
    compose.onNodeWithTag(episodeCardTag(v2())).assertIsFocused()
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagCatalogEpisode).assertTextContains("S1 · E2 · Two")
  }

  @Test
  fun `OK on an episode selects it and moves focus to Play`() {
    val api = seriesApi()
    api.metaValues["series:tt1"] = seriesMeta(v1(), v2())
    api.streamsValues["series:tt1:1:1"] = listOf(stream("s1", name = "One's source"))
    api.streamsValues["series:tt1:1:2"] = listOf(stream("s2", name = "Two's source"))
    mount(api, seriesArgs())
    compose.waitForIdle()

    press(Key.DirectionDown)
    press(Key.DirectionRight)
    compose.onNodeWithTag(episodeCardTag(v2())).assertIsFocused()
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
    assertTrue(api.streamsRequests.contains("series:tt1:1:2"))
    compose.onNodeWithTag(TagCatalogEpisode).assertTextContains("S1 · E2 · Two")
  }

  @Test
  fun `OK on the already selected episode just moves focus to Play`() {
    val api = seriesApi()
    api.metaValues["series:tt1"] = seriesMeta(v1(), v2())
    api.streamsValues["series:tt1:1:1"] = listOf(stream("s1", name = "One's source"))
    mount(api, seriesArgs())
    compose.waitForIdle()

    press(Key.DirectionDown)
    compose.onNodeWithTag(episodeCardTag(v1())).assertIsFocused()
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
    compose.onNodeWithTag(TagCatalogEpisode).assertTextContains("S1 · E1 · One")
    assertEquals(1, api.streamsRequests.count { it == "series:tt1:1:1" })
  }

  @Test
  fun `pressing Sources in a series lists the selected episode's sources`() {
    val api = seriesApi()
    api.metaValues["series:tt1"] = seriesMeta(v1(), v2())
    api.streamsValues["series:tt1:1:1"] = listOf(stream("s1", name = "One's source"))
    mount(api, seriesArgs())
    compose.waitForIdle()

    openSources()
    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()
    press(Key.DirectionCenter)

    assertTrue(played.isEmpty())
    compose.onNodeWithTag(TagSourcesPanel).assertDoesNotExist()
    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
  }

  // --- Review fixes -------------------------------------------------------------------------

  private fun seriesApi(): FakeTvApi {
    val api = FakeTvApi()
    api.settingsValue = settings()
    return api
  }

  private fun seriesArgs() = CatalogDetailArgs(MetaDto(id = "tt1", type = "series", name = "Show"), "Cinemeta", "series")

  private fun seriesMeta(vararg videos: VideoDto) =
    MetaDto(id = "tt1", type = "series", name = "Show", videos = videos.toList())

  private fun v1() = VideoDto(id = "tt1:1:1", title = "One", season = 1, episode = 1)
  private fun v2() = VideoDto(id = "tt1:1:2", title = "Two", season = 1, episode = 2)

  private fun watched(video: VideoDto) = ProgressEntryDto(
    key = "series:tt1:1:1",
    position = 600.0,
    duration = 600.0,
    title = "Show · ${video.title}",
    series = ProgressEntryDto.Series("tt1", "Show", 1, 1),
  )

  @Test
  fun `switching episode cannot play the previous episode's source`() {
    val api = seriesApi()
    val first = v1()
    val second = v2()
    api.metaValues["series:tt1"] = seriesMeta(first, second)
    api.progressEntries = listOf(watched(first))
    api.streamsValues["series:tt1:1:1"] = (1..3).map { stream("s1-$it", name = "One's source $it") }
    api.streamsValues["series:tt1:1:2"] = listOf(stream("s2", name = "Two's source"))
    // Episode two's streams stay in flight, so a stale episode one answer is all there is to play.
    val gate = CompletableDeferred<Unit>()
    api.streamsGates["series:tt1:1:2"] = gate
    mount(api, seriesArgs())
    compose.waitForIdle()

    press(Key.DirectionDown)
    compose.onNodeWithTag(episodeCardTag(second)).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitForIdle()
    // Selecting the episode moves the remote to Play; OK there must not reach episode one's stale
    // source while episode two's streams are still in flight.
    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
    press(Key.DirectionCenter)

    assertTrue(played.isEmpty())
    gate.complete(Unit)
  }

  @Test
  fun `an abandoned stream load does not blank the new episode`() {
    val api = seriesApi()
    val first = v1()
    val second = v2()
    api.metaValues["series:tt1"] = seriesMeta(first, second)
    api.progressEntries = listOf(watched(first))
    // Three sources on episode one against one on episode two, so a stale write is visible.
    api.streamsValues["series:tt1:1:1"] = (1..3).map { stream("s1-$it", name = "One's source $it") }
    api.streamsValues["series:tt1:1:2"] = listOf(stream("s2", name = "Two's source"))
    api.streamsGates["series:tt1:1:1"] = CompletableDeferred()
    mount(api, seriesArgs())
    compose.waitForIdle()

    press(Key.DirectionDown)
    compose.onNodeWithTag(episodeCardTag(second)).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitForIdle()
    compose.onNodeWithTag(TagCatalogSources).assertTextContains("Sources · 1")
  }

  @Test
  fun `play while the sources load arms the wait and keeps a message away`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamsValues["movie:tt1"] = listOf(stream("s1", name = "FullHD"))
    api.streamsGates["movie:tt1"] = CompletableDeferred()
    mount(api, movieArgs())
    compose.waitForIdle()

    press(Key.DirectionCenter)

    assertTrue(played.isEmpty())
    compose.onNodeWithTag(TagCatalogMessage).assertDoesNotExist()
    compose.onNodeWithTag(TagCatalogPrimary).assertTextContains("Starting when sources are ready…")
    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
  }

  @Test
  fun `a failed addon list shows the error and retries`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamSourcesFailures["movie:tt1"] = cz.stremiooffline.tv.data.ApiFailure.Generic
    api.streamsValues["movie:tt1"] = listOf(stream("s1", name = "FullHD"))
    mount(api, movieArgs())
    compose.waitForIdle()

    openSources()
    compose.onNodeWithText("The library could not be loaded.").assertExists()

    api.streamSourcesFailures.remove("movie:tt1")
    focusFromLeft(TagCatalogRetry)
    press(Key.DirectionCenter)

    compose.onNodeWithTag(sourceRowTag(0)).assertExists()
  }

  @Test
  fun `the no sources message clears after switching to an episode with sources`() {
    val api = seriesApi()
    val first = v1()
    val second = v2()
    api.metaValues["series:tt1"] = seriesMeta(first, second)
    api.streamsValues["series:tt1:1:2"] = listOf(stream("s2", name = "Two's source"))
    mount(api, seriesArgs())
    compose.waitForIdle()

    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagCatalogMessage).assertTextContains("No active source addon has a stream for this title.")

    press(Key.DirectionDown)
    compose.onNodeWithTag(episodeCardTag(first)).assertIsFocused()
    press(Key.DirectionRight)
    compose.onNodeWithTag(episodeCardTag(second)).assertIsFocused()
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagCatalogMessage).assertDoesNotExist()
    compose.onNodeWithTag(TagCatalogSources).assertTextContains("Sources · 1")
  }

  @Test
  fun `a torrent without a debrid token says it cannot be played`() {
    val api = FakeTvApi()
    api.settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", realDebridConfigured = false)
    api.streamsValues["movie:tt1"] = listOf(stream("s1", playable = false, kind = "torrent", title = "Czech 8 GB"))
    mount(api, movieArgs())
    compose.waitForIdle()

    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagCatalogMessage).assertTextContains("A torrent cannot be played directly.", substring = true)
  }

  @Test
  fun `favourite applies the server's answer`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamsValues["movie:tt1"] = listOf(stream("s1", name = "FullHD"))
    api.watchlistAnswer = { false }
    mount(api, movieArgs())
    compose.waitForIdle()

    focusFromLeft(TagCatalogFavourite)
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagCatalogFavourite).assertTextContains("☆")
  }

  @Test
  fun `a second favourite press while one is in flight is ignored`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamsValues["movie:tt1"] = listOf(stream("s1", name = "FullHD"))
    val gate = CompletableDeferred<Unit>()
    api.watchlistGate = gate
    mount(api, movieArgs())
    compose.waitForIdle()

    focusFromLeft(TagCatalogFavourite)
    press(Key.DirectionCenter)
    press(Key.DirectionCenter)

    assertEquals(1, api.favoriteCalls.size)
    gate.complete(Unit)
    compose.waitForIdle()
    compose.onNodeWithTag(TagCatalogFavourite).assertTextContains("★")
  }

  @Test
  fun `a failing favourite reverts the star`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamsValues["movie:tt1"] = listOf(stream("s1", name = "FullHD"))
    api.watchlistFailure = cz.stremiooffline.tv.data.ApiFailure.Generic
    mount(api, movieArgs())
    compose.waitForIdle()

    focusFromLeft(TagCatalogFavourite)
    press(Key.DirectionCenter)
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogFavourite).assertTextContains("☆")
  }

  @Test
  fun `progress is re-read when the player returns`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamsValues["movie:tt1"] = listOf(stream("s1", name = "FullHD"))
    val token = mutableIntStateOf(0)
    compose.setContent {
      CatalogDetailScreen(
        api = api,
        args = movieArgs(),
        imageUrl = { null },
        onPlay = { played += it },
        onBack = {},
        restoreToken = token.intValue,
      )
    }
    compose.waitForIdle()
    compose.onNodeWithText("Play").assertIsDisplayed()

    api.progressValues["movie:tt1"] = ProgressDto(38.6, 120.0)
    compose.runOnIdle { token.intValue = 1 }

    compose.onNodeWithText("Resume").assertIsDisplayed()
    press(Key.DirectionCenter)
    assertEquals(true, played.last().resume)
  }

  @Test
  fun `entering a series does not request the series id`() {
    val api = seriesApi()
    api.metaValues["series:tt1"] = seriesMeta(v1())
    api.streamsValues["series:tt1:1:1"] = listOf(stream("s1", name = "One's source"))
    mount(api, seriesArgs())
    compose.waitForIdle()

    assertFalse(api.streamsRequests.contains("series:tt1"))
    assertFalse(api.streamSourcesRequests.contains("series:tt1"))
  }

  @Test
  fun `opened from Home a series selects the named episode's sources`() {
    val api = seriesApi()
    api.metaValues["series:tt1"] = seriesMeta(v1(), v2())
    api.streamsValues["series:tt1:1:1"] = listOf(stream("s1", name = "First's source"))
    api.streamsValues["series:tt1:1:2"] = listOf(stream("s2", name = "Second's source"))
    mount(
      api,
      CatalogDetailArgs(
        MetaDto(id = "tt1", type = "series", name = "Show"),
        "Cinemeta",
        "series",
        episode = ResumeEpisode("series:tt1:1:2", 1, 2),
      ),
    )
    compose.waitForIdle()

    assertTrue(api.streamsRequests.contains("series:tt1:1:2"))
    assertFalse(api.streamsRequests.contains("series:tt1:1:1"))
  }

  @Test
  fun `the season row scrolls as the D-pad walks to a far season`() {
    val api = seriesApi()
    val videos = (1..30).map { season -> VideoDto(id = "tt1:$season:1", title = "S$season", season = season, episode = 1) }
    api.metaValues["series:tt1"] = seriesMeta(*videos.toTypedArray())
    api.streamsValues["series:tt1:1:1"] = listOf(stream("s1", name = "FullHD"))
    api.streamsValues["series:tt1:30:1"] = listOf(stream("s30", name = "FullHD"))
    mount(api, seriesArgs())
    compose.waitForIdle()

    // DOWN lands on the episode row, UP climbs back to the season chips.
    press(Key.DirectionDown)
    press(Key.DirectionUp)
    compose.onNodeWithTag(seasonChipTag(1)).assertIsFocused()

    repeat(29) {
      press(Key.DirectionRight)
    }
    compose.onNodeWithTag(seasonChipTag(30)).assertIsFocused()
    compose.onNodeWithTag(seasonChipTag(30)).assertIsDisplayed()

    press(Key.DirectionCenter)
    compose.waitForIdle()
    compose.onNodeWithTag(episodeCardTag(videos[29])).assertExists()
    compose.onNodeWithTag(episodeCardTag(videos[0])).assertDoesNotExist()
  }

  // --- Review round 2 -------------------------------------------------------------------------

  private fun source(key: String) = StreamSourceDto(key, key.replaceFirstChar { it.uppercase() })

  @Test
  fun `DOWN from the action row is not eaten before the episodes arrive`() {
    val api = seriesApi()
    api.metaValues["series:tt1"] = seriesMeta(v1(), v2())
    api.streamsValues["series:tt1:1:1"] = listOf(stream("s1", name = "One's source"))
    val meta = CompletableDeferred<Unit>()
    api.metaGates["series:tt1"] = meta
    var downReachedSearch = false
    compose.setContent {
      Box(
        Modifier.onKeyEvent { event ->
          if (event.type == KeyEventType.KeyDown && event.key == Key.DirectionDown) downReachedSearch = true
          false
        },
      ) {
        CatalogDetailScreen(api = api, args = seriesArgs(), imageUrl = { null }, onPlay = { played += it }, onBack = {})
      }
    }
    compose.waitForIdle()
    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()

    // The meta has not answered, so no card carries the episode-row requester: DOWN must reach the
    // focus search instead of being swallowed by the handler.
    downReachedSearch = false
    press(Key.DirectionDown)
    assertTrue(downReachedSearch)

    meta.complete(Unit)
    compose.waitForIdle()
    press(Key.DirectionDown)
    compose.onNodeWithTag(episodeCardTag(v1())).assertIsFocused()
  }

  @Test
  fun `Play on a chosen unplayable row never arms the wait for another addon`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamSourcesValues["movie:tt1"] = listOf(source("alpha"), source("beta"))
    api.addonStreams["movie:tt1|alpha"] =
      listOf(stream("srcA", playable = false, kind = "remote", name = "External", title = "Czech 1 GB", addonName = "Alpha"))
    api.addonStreams["movie:tt1|beta"] = listOf(stream("srcB", name = "Large", title = "Czech 8 GB", addonName = "Beta"))
    val beta = CompletableDeferred<Unit>()
    api.streamsGates["movie:tt1|beta"] = beta
    mount(api, movieArgs())
    compose.waitUntil(5_000) { api.streamsCompleted.contains("movie:tt1|alpha") }
    compose.waitForIdle()

    openSources()
    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()

    // The pick is unplayable, so Play says so at once rather than waiting for the other addon.
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagCatalogMessage).assertTextContains("A torrent cannot be played directly.", substring = true)
    assertTrue(played.isEmpty())

    beta.complete(Unit)
    compose.waitUntil(5_000) { api.streamsCompleted.contains("movie:tt1|beta") }
    compose.waitForIdle()
    assertTrue(played.isEmpty())
    compose.onNodeWithTag(TagCatalogMessage).assertTextContains("A torrent cannot be played directly.", substring = true)
  }

  @Test
  fun `a focused To library moves to Play when the chosen stream can no longer be queued`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamSourcesValues["movie:tt1"] = listOf(source("alpha"), source("beta"), source("gamma"))
    api.addonStreams["movie:tt1|alpha"] =
      listOf(stream("srcA", playable = false, kind = "torrent", title = "Czech 1 GB", addonName = "Alpha"))
    api.addonStreams["movie:tt1|beta"] =
      listOf(stream("srcB", playable = false, kind = "remote", title = "Czech 8 GB", addonName = "Beta"))
    api.addonStreams["movie:tt1|gamma"] = emptyList()
    val beta = CompletableDeferred<Unit>()
    val gamma = CompletableDeferred<Unit>()
    api.streamsGates["movie:tt1|beta"] = beta
    api.streamsGates["movie:tt1|gamma"] = gamma
    mount(api, movieArgs())
    compose.waitUntil(5_000) { api.streamsCompleted.contains("movie:tt1|alpha") }
    compose.waitForIdle()

    focusFromLeft(TagCatalogToLibrary)
    compose.onNodeWithTag(TagCatalogToLibrary).assertIsFocused()

    // The larger Beta lands while Gamma is still out: it outranks Alpha and cannot be queued, so the
    // button the remote is on disappears.
    beta.complete(Unit)
    compose.waitUntil(5_000) { api.streamsCompleted.contains("movie:tt1|beta") }
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogToLibrary).assertDoesNotExist()
    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
    gamma.complete(Unit)
  }

  @Test
  fun `Play without picking a source shows no chosen caption`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamsValues["movie:tt1"] = listOf(stream("s1", name = "FullHD"))
    mount(api, movieArgs())
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
    press(Key.DirectionCenter)

    assertEquals(listOf("s1"), played.map { it.sourceId })
    compose.onNodeWithTag(TagCatalogChosenSource).assertDoesNotExist()
  }
}
