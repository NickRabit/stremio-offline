@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
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
import androidx.compose.runtime.mutableIntStateOf
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.catalog.ResumeEpisode
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.ProgressEntryDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import java.util.concurrent.CountDownLatch
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
  fun `sources open in arrangeStreams order, the default is marked and OK plays it`() {
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

    // Recommended puts the largest first, so the ticked row is srcB and OK plays it.
    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()
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
    val gate = CountDownLatch(1)
    api.streamsLatches["series:tt1:1:2"] = gate
    mount(api, seriesArgs())
    compose.waitForIdle()

    press(Key.DirectionDown)
    compose.onNodeWithTag(episodeCardTag(second)).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitForIdle()
    press(Key.DirectionLeft)
    press(Key.DirectionUp)
    press(Key.DirectionUp)
    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
    press(Key.DirectionCenter)

    assertTrue(played.isEmpty())
    gate.countDown()
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
    api.streamsLatches["series:tt1:1:1"] = CountDownLatch(1)
    mount(api, seriesArgs())
    compose.waitForIdle()

    press(Key.DirectionDown)
    compose.onNodeWithTag(episodeCardTag(second)).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitForIdle()
    compose.onNodeWithTag(TagCatalogSources).assertTextContains("Sources · 1")
  }

  @Test
  fun `play while the sources load does nothing and keeps a message away`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamsValues["movie:tt1"] = listOf(stream("s1", name = "FullHD"))
    api.streamsLatches["movie:tt1"] = CountDownLatch(1)
    mount(api, movieArgs())
    compose.waitForIdle()

    press(Key.DirectionCenter)

    assertTrue(played.isEmpty())
    compose.onNodeWithTag(TagCatalogMessage).assertDoesNotExist()
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
    val latch = CountDownLatch(1)
    api.watchlistLatch = latch
    mount(api, movieArgs())
    compose.waitForIdle()

    focusFromLeft(TagCatalogFavourite)
    press(Key.DirectionCenter)
    press(Key.DirectionCenter)

    assertEquals(1, api.favoriteCalls.size)
    latch.countDown()
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
}
