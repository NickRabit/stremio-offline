@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.activity.ComponentActivity
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.BulkDownloadResult
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.ProgressEntryDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.SourceProfileDto
import cz.stremiooffline.tv.data.StreamSourceDto
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.ui.FakeTvApi
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The bulk download the TV offers on a series detail, driven with the remote alone. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class SeriesDownloadPanelTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private val videos = listOf(
    VideoDto(id = "s0e1", season = 0, episode = 1, released = "2020-01-01"),
    VideoDto(id = "s1e1", season = 1, episode = 1, released = "2020-01-01"),
    VideoDto(id = "s1e2", season = 1, episode = 2, released = "2020-01-01"),
    VideoDto(id = "s1e3", season = 1, episode = 3, released = "2999-01-01"),
    VideoDto(id = "s2e1", season = 2, episode = 1, released = "2020-01-01"),
  )

  /** Half-way through the second episode: the panel then has an episode before and after it. */
  private fun ready(): FakeTvApi {
    val api = FakeTvApi()
    api.settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", subtitleLanguage = "cs", realDebridConfigured = true)
    api.progressEntries = listOf(
      ProgressEntryDto(
        key = "series:tt1",
        position = 60.0,
        duration = 600.0,
        title = "Show",
        series = ProgressEntryDto.Series(id = "tt1", name = "Show", season = 1, episode = 2),
      ),
    )
    api.streamSourcesValues["series:s1e2"] = listOf(StreamSourceDto("alpha", "Alpha"), StreamSourceDto("beta", "Beta"))
    api.librariesValue = listOf(
      LibraryDto(id = "shows", name = "TV shows", type = "series", writable = true),
      LibraryDto(id = "mixed", name = "Everything", type = "mixed", writable = true),
      LibraryDto(id = "films", name = "Films", type = "movie", writable = true),
    )
    return api
  }

  private fun mount(api: FakeTvApi) {
    compose.setContent {
      CatalogDetailScreen(
        api = api,
        args = CatalogDetailArgs(
          MetaDto(id = "tt1", type = "series", name = "Show", poster = "p.jpg", videos = videos),
          "alpha",
          "series",
        ),
        imageUrl = { null },
        onPlay = {},
        onBack = {},
      )
    }
    compose.waitForIdle()
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun back() {
    compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()
  }

  private fun focused(tag: String): Boolean =
    compose.onAllNodes(isFocused()).fetchSemanticsNodes()
      .any { it.config.getOrElse(SemanticsProperties.TestTag) { "" } == tag }

  private fun focusRight(tag: String) {
    repeat(8) {
      if (focused(tag)) return
      press(Key.DirectionRight)
    }
    compose.onNodeWithTag(tag).assertIsFocused()
  }

  private fun focusDown(tag: String) {
    repeat(16) {
      if (focused(tag)) return
      press(Key.DirectionDown)
    }
    compose.onNodeWithTag(tag).assertIsFocused()
  }

  private fun focusUp(tag: String) {
    repeat(16) {
      if (focused(tag)) return
      press(Key.DirectionUp)
    }
    compose.onNodeWithTag(tag).assertIsFocused()
  }

  /** Opens the bulk panel from the action row, the way the remote gets there. */
  private fun openPanel() {
    focusRight(TagCatalogSeriesDownload)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSeriesDownloadPanel).assertExists()
  }

  /** Picks a scope and leaves the remote on the queue row of the settings. */
  private fun openSettings(scope: DownloadScope) {
    openPanel()
    focusDown(seriesScopeTag(scope))
    press(Key.DirectionCenter)
    focusDown(TagSeriesDownloadAdd)
  }

  @Test
  fun `the panel opens on the scopes, each with the released episodes it would add`() {
    val api = ready()
    mount(api)
    openPanel()

    compose.onNodeWithTag(seriesScopeTag(DownloadScope.Episode)).assertIsFocused()
    compose.onNodeWithTag(seriesScopeTag(DownloadScope.Episode)).assertTextContains("This episode · 1")
    compose.onNodeWithTag(seriesScopeTag(DownloadScope.Season)).assertTextContains("This season (1) · 2")
    compose.onNodeWithTag(seriesScopeTag(DownloadScope.FromEpisode)).assertTextContains("From this episode on · 2")
    compose.onNodeWithTag(seriesScopeTag(DownloadScope.All)).assertTextContains("All episodes · 3")
  }

  @Test
  fun `the settings open with the summary of what would be queued`() {
    val api = ready()
    mount(api)
    openSettings(DownloadScope.All)

    compose.onNodeWithTag(TagSeriesDownloadSummary).assertTextContains("3 episodes → TV shows")
  }

  @Test
  fun `this episode queues the selected one alone`() {
    val api = ready()
    mount(api)
    openSettings(DownloadScope.Episode)

    press(Key.DirectionCenter)

    assertEquals(listOf("s1e2"), api.bulkDownloads.single().episodes.map { it.id })
  }

  @Test
  fun `this season queues the released episodes of the season`() {
    val api = ready()
    mount(api)
    openSettings(DownloadScope.Season)

    press(Key.DirectionCenter)

    assertEquals(listOf("s1e1", "s1e2"), api.bulkDownloads.single().episodes.map { it.id })
  }

  @Test
  fun `from this episode on queues it and the ones after it`() {
    val api = ready()
    mount(api)
    openSettings(DownloadScope.FromEpisode)

    press(Key.DirectionCenter)

    assertEquals(listOf("s1e2", "s2e1"), api.bulkDownloads.single().episodes.map { it.id })
  }

  @Test
  fun `all episodes queues the released regulars, leaving out the special and the unreleased`() {
    val api = ready()
    mount(api)
    openSettings(DownloadScope.All)

    press(Key.DirectionCenter)

    assertEquals(listOf("s1e1", "s1e2", "s2e1"), api.bulkDownloads.single().episodes.map { it.id })
  }

  @Test
  fun `the body carries the web's non-follow defaults`() {
    val api = ready()
    mount(api)
    openSettings(DownloadScope.All)

    press(Key.DirectionCenter)

    val body = api.bulkDownloads.single()
    assertEquals("Show", body.title)
    assertEquals("series", body.type)
    assertEquals(listOf("alpha", "beta"), body.selection.addonKeys)
    assertEquals("largest", body.selection.sourceStrategy)
    assertEquals("en", body.selection.audioLanguage)
    assertEquals(null, body.selection.fallbackAudioLanguage)
    assertEquals("listed", body.selection.audioMode)
    assertEquals("optional", body.selection.subtitleMode)
    assertEquals("cs", body.selection.subtitleLanguage)
    assertEquals("en", body.selection.fallbackSubtitleLanguage)
    assertEquals("tt1", body.media.id)
    assertEquals("series", body.media.metaType)
    assertEquals("p.jpg", body.media.poster)
    assertEquals("shows", body.target?.libraryId)
  }

  @Test
  fun `changing the audio language and its fallback changes the body`() {
    val api = ready()
    mount(api)
    openSettings(DownloadScope.Episode)

    focusUp(TagSeriesDownloadAudio)
    press(Key.DirectionCenter)
    focusDown(seriesAudioTag("de"))
    press(Key.DirectionCenter)
    focusDown(seriesAudioFallbackTag("en"))
    press(Key.DirectionCenter)
    back()
    focusDown(TagSeriesDownloadAdd)
    press(Key.DirectionCenter)

    val selection = api.bulkDownloads.single().selection
    assertEquals("de", selection.audioLanguage)
    assertEquals("en", selection.fallbackAudioLanguage)
  }

  @Test
  fun `changing the subtitle mode changes the body`() {
    val api = ready()
    mount(api)
    openSettings(DownloadScope.Episode)

    focusUp(TagSeriesDownloadSubtitles)
    press(Key.DirectionCenter)
    focusDown(seriesSubtitleModeTag("required"))
    press(Key.DirectionCenter)
    back()
    focusDown(TagSeriesDownloadAdd)
    press(Key.DirectionCenter)

    assertEquals("required", api.bulkDownloads.single().selection.subtitleMode)
  }

  @Test
  fun `changing the source strategy changes the body`() {
    val api = ready()
    mount(api)
    openSettings(DownloadScope.Episode)

    focusUp(TagSeriesDownloadStrategy)
    press(Key.DirectionCenter)
    focusDown(seriesStrategyTag("priority"))
    press(Key.DirectionCenter)
    back()
    focusDown(TagSeriesDownloadAdd)
    press(Key.DirectionCenter)

    assertEquals("priority", api.bulkDownloads.single().selection.sourceStrategy)
  }

  @Test
  fun `a source profile hides the manual rows and posts its id and revision`() {
    val api = ready()
    api.sourceProfilesValue = listOf(
      SourceProfileDto(
        id = "travel",
        nameKey = "sourceProfile.travel",
        revision = 1,
        operations = listOf("play", "downloadToLibrary"),
      ),
    )
    mount(api)
    openSettings(DownloadScope.Episode)

    focusUp(TagSeriesDownloadStrategy)
    press(Key.DirectionCenter)
    focusDown(seriesStrategyTag("profile:travel"))
    compose.onNodeWithTag(seriesStrategyTag("profile:travel"))
      .assertTextContains("Travel (small files)", substring = true)
      .assertTextContains("The smallest file of at least 480p in your language.", substring = true)
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagSeriesDownloadAudio).assertDoesNotExist()
    compose.onNodeWithTag(TagSeriesDownloadSubtitles).assertDoesNotExist()
    compose.onNodeWithTag(TagSeriesDownloadSources).assertDoesNotExist()
    compose.onNodeWithTag(TagSeriesDownloadLibrary).assertIsDisplayed()
    focusDown(TagSeriesDownloadAdd)
    press(Key.DirectionCenter)

    assertEquals(
      cz.stremiooffline.tv.data.DownloadProfileRefDto("travel", 1),
      api.bulkDownloads.single().selection.profile,
    )
    assertEquals(emptyList<String>(), api.bulkDownloads.single().selection.addonKeys)
  }

  @Test
  fun `a profile fetch failure leaves the two legacy strategies`() {
    val api = ready()
    api.sourceProfilesFailure = ApiFailure.Generic
    mount(api)
    openSettings(DownloadScope.Episode)

    focusUp(TagSeriesDownloadStrategy)
    press(Key.DirectionCenter)

    compose.onNodeWithTag(seriesStrategyTag("largest")).assertIsFocused()
    compose.onNodeWithTag(seriesStrategyTag("priority")).assertIsDisplayed()
    compose.onNodeWithTag(seriesStrategyTag("profile:travel")).assertDoesNotExist()
  }

  @Test
  fun `a profile without library downloads is not offered`() {
    val api = ready()
    api.sourceProfilesValue = listOf(
      SourceProfileDto(
        id = "travel",
        nameKey = "sourceProfile.travel",
        revision = 1,
        operations = listOf("play", "downloadToDevice"),
      ),
    )
    mount(api)
    openSettings(DownloadScope.Episode)

    focusUp(TagSeriesDownloadStrategy)
    press(Key.DirectionCenter)

    compose.onNodeWithTag(seriesStrategyTag("largest")).assertIsDisplayed()
    compose.onNodeWithTag(seriesStrategyTag("priority")).assertIsDisplayed()
    compose.onNodeWithTag(seriesStrategyTag("profile:travel")).assertDoesNotExist()
  }

  @Test
  fun `a remembered offered profile is preselected`() {
    val api = ready()
    api.settingsValue = api.settingsValue.copy(downloadSourceProfile = "travel")
    api.sourceProfilesValue = listOf(
      SourceProfileDto(
        id = "travel",
        nameKey = "sourceProfile.travel",
        revision = 1,
        operations = listOf("downloadToLibrary"),
      ),
    )
    mount(api)
    openSettings(DownloadScope.Episode)

    compose.onNodeWithTag(TagSeriesDownloadStrategy).assertTextContains("Travel (small files)", substring = true)
    compose.onNodeWithTag(TagSeriesDownloadAudio).assertDoesNotExist()
    focusUp(TagSeriesDownloadStrategy)
    press(Key.DirectionCenter)
    focusDown(seriesStrategyTag("profile:travel"))
    compose.onNodeWithTag(seriesStrategyTag("profile:travel")).assertIsFocused().assertIsSelected()
  }

  @Test
  fun `clearing an addon takes it out of the body`() {
    val api = ready()
    mount(api)
    openSettings(DownloadScope.Episode)

    focusUp(TagSeriesDownloadSources)
    press(Key.DirectionCenter)
    focusDown(seriesSourceTag("beta"))
    press(Key.DirectionCenter)
    back()
    focusDown(TagSeriesDownloadAdd)
    press(Key.DirectionCenter)

    assertEquals(listOf("alpha"), api.bulkDownloads.single().selection.addonKeys)
  }

  @Test
  fun `picking another library puts it in the target`() {
    val api = ready()
    mount(api)
    openSettings(DownloadScope.Episode)

    focusUp(TagSeriesDownloadLibrary)
    press(Key.DirectionCenter)
    focusDown(seriesLibraryTag("mixed"))
    press(Key.DirectionCenter)
    back()
    focusDown(TagSeriesDownloadAdd)
    press(Key.DirectionCenter)

    assertEquals("mixed", api.bulkDownloads.single().target?.libraryId)
  }

  @Test
  fun `a refusal stays in the panel with the server's own message`() {
    val api = ready()
    api.bulkDownloadFailure = ApiFailure.Forbidden
    api.bulkDownloadFailureMessage = "This account may not download to the library."
    mount(api)
    openSettings(DownloadScope.Episode)

    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagSeriesDownloadPanel).assertExists()
    compose.onNodeWithTag(TagSeriesDownloadError).assertTextContains("This account may not download to the library.")
  }

  @Test
  fun `a queued batch says what it added and hands the remote back to the button`() {
    val api = ready()
    api.bulkDownloadResult = BulkDownloadResult(added = 3, skipped = 1)
    mount(api)
    openSettings(DownloadScope.All)

    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagSeriesDownloadPanel).assertDoesNotExist()
    compose.onNodeWithTag(TagCatalogMessage).assertTextContains("3 episodes added to the queue. 1 skipped, already queued.")
    compose.onNodeWithTag(TagCatalogSeriesDownload).assertIsFocused()
  }

  @Test
  fun `a second press while the batch posts does not post it twice`() {
    val api = ready()
    api.bulkDownloadGate = CompletableDeferred()
    mount(api)
    openSettings(DownloadScope.Episode)

    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSeriesDownloadAdd).assertIsNotEnabled()
    press(Key.DirectionCenter)

    assertEquals(1, api.bulkDownloadCalls)
    api.bulkDownloadGate!!.complete(Unit)
    compose.waitForIdle()
  }

  @Test
  fun `Back walks the levels and leaves the remote on the opener`() {
    val api = ready()
    mount(api)
    openPanel()

    focusDown(seriesScopeTag(DownloadScope.Season))
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSeriesDownloadAudio).assertIsFocused()

    focusDown(TagSeriesDownloadSources)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(seriesSourceTag("alpha")).assertIsDisplayed()

    back()
    compose.onNodeWithTag(TagSeriesDownloadSources).assertIsFocused()
    back()
    compose.onNodeWithTag(seriesScopeTag(DownloadScope.Season)).assertIsFocused()
    back()
    compose.onNodeWithTag(TagSeriesDownloadPanel).assertDoesNotExist()
    compose.onNodeWithTag(TagCatalogSeriesDownload).assertIsFocused()
  }
}
