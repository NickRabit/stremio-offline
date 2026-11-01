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
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.BulkDownloadResult
import cz.stremiooffline.tv.data.BulkPreparedEpisodeDto
import cz.stremiooffline.tv.data.BulkPreparedSeriesDto
import cz.stremiooffline.tv.data.BulkPreparedTargetDto
import cz.stremiooffline.tv.data.BulkPrepareListingDto
import cz.stremiooffline.tv.data.BulkPrepareResponse
import cz.stremiooffline.tv.data.BulkMediaDto
import cz.stremiooffline.tv.data.DownloadSelectionDto
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.ProgressEntryDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.SourceProfileAudioDto
import cz.stremiooffline.tv.data.SourceProfileConstraintsDto
import cz.stremiooffline.tv.data.SourceProfileCriterionDto
import cz.stremiooffline.tv.data.SourceProfileDto
import cz.stremiooffline.tv.data.SourceProfileLanguageRefDto
import cz.stremiooffline.tv.data.SourceProfilePolicyDto
import cz.stremiooffline.tv.data.SourceProfileRangeDto
import cz.stremiooffline.tv.data.StreamSourceDto
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.ui.FakeTvApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.Json
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

  private val json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = false }
  private var currentApi: FakeTvApi? = null

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
    api.sourceProfilesValue = listOf(rule("balanced", nameKey = "rules.preset.balanced"))
    api.bulkPrepareAnswer = { request ->
      BulkPrepareResponse(
        origin = request.origin.kind,
        series = BulkPreparedSeriesDto("Show", catalogueId = "tt1"),
        target = BulkPreparedTargetDto(
          libraryId = request.target?.libraryId ?: "shows",
          libraryName = api.librariesValue.firstOrNull { it.id == request.target?.libraryId }?.name ?: "TV shows",
        ),
        episodes = listOf(
          BulkPreparedEpisodeDto("s0e1", 0, 1, "Special", status = "ready"),
          BulkPreparedEpisodeDto("s1e1", 1, 1, "One", status = "ready"),
          BulkPreparedEpisodeDto("s1e2", 1, 2, "Two", status = "ready"),
          BulkPreparedEpisodeDto("s1e3", 1, 3, "Three", status = "unreleased"),
          BulkPreparedEpisodeDto("s2e1", 2, 1, "Later", status = "ready"),
        ),
        listing = BulkPrepareListingDto(complete = true),
      )
    }
    return api
  }

  private fun mount(api: FakeTvApi) {
    currentApi = api
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

  private fun waitFocused(tag: String) {
    compose.waitUntil(5_000) { focused(tag) }
  }

  /** Opens the bulk panel from the action row, the way the remote gets there. */
  private fun openPanel(waitForPrepare: Boolean = true) {
    focusRight(TagCatalogToLibrary)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSeriesDownloadPanel).assertExists()
    if (waitForPrepare) compose.waitUntil(5_000) { currentApi!!.bulkPrepareCalls > 0 }
  }

  /** Picks a scope and leaves the remote on the queue row of the settings. */
  private fun openSettings(scope: DownloadScope) {
    openPanel(waitForPrepare = false)
    focusDown(seriesScopeTag(scope))
    press(Key.DirectionCenter)
    focusDown(TagSeriesDownloadAdd)
  }

  private fun assertNoLegacyRows() {
    for (tag in listOf(
      "series_download_audio",
      "series_download_subtitles",
      "series_download_sources",
      "series_download_strategy",
      "series_strategy_largest",
      "series_strategy_priority",
    )) {
      compose.onNodeWithTag(tag).assertDoesNotExist()
    }
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

    compose.onNodeWithTag(TagSeriesDownloadSummary)
      .assertTextContains("3 episodes ready", substring = true)
      .assertTextContains("1 not released yet", substring = true)
    compose.onNodeWithText("Sources are chosen when each episode downloads.").assertExists()
  }

  @Test
  fun `this episode with its chosen source hands over to the source panel`() {
    val api = ready()
    api.streamsValues["series:s1e2"] = listOf(cz.stremiooffline.tv.data.StreamDto(sourceId = "s1", kind = "remote", playable = true, name = "FullHD"))
    mount(api)
    compose.waitUntil(5_000) { api.streamsRequests.any { it.startsWith("series:s1e2") } }
    compose.waitForIdle()
    openPanel(waitForPrepare = false)

    // The first row stands for To library's own single save, so the rules-picked episode is gone.
    compose.onNodeWithTag(TagSeriesDownloadThisEpisode)
      .assertIsFocused()
      .assertTextContains("This episode · chosen source", substring = true)
    compose.onNodeWithTag(seriesScopeTag(DownloadScope.Episode)).assertDoesNotExist()
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagSeriesDownloadPanel).assertDoesNotExist()
    compose.onNodeWithTag(TagTitleDownloadPanel).assertExists()
    assertEquals(0, api.bulkDownloads.size)
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
  fun `the body carries only the chosen rule`() {
    val api = ready()
    mount(api)
    openSettings(DownloadScope.All)

    press(Key.DirectionCenter)

    val body = api.bulkDownloads.single()
    assertEquals("Show", body.title)
    assertEquals("series", body.type)
    assertEquals("tt1", body.media.id)
    assertEquals("series", body.media.metaType)
    assertEquals("p.jpg", body.media.poster)
    assertEquals("shows", body.target?.libraryId)
    assertEquals(
      """{"profile":{"profileId":"balanced","revision":1}}""",
      json.encodeToString(DownloadSelectionDto.serializer(), body.selection),
    )
  }

  @Test
  fun `choosing smaller files posts that rule and leaves the legacy rows out`() {
    val api = ready()
    api.sourceProfilesValue = listOf(
      rule("balanced", nameKey = "rules.preset.balanced", min = 720, max = 1080, audio = "preferred", bytes = 4_000_000_000, criteria = listOf(SourceProfileCriterionDto("audioTier"))),
      rule("best", nameKey = "rules.preset.best", min = 1080, max = 2160, audio = "preferred", criteria = listOf(SourceProfileCriterionDto("audioTier"))),
      rule("smaller", nameKey = "rules.preset.smaller", revision = 4, min = 480, max = 720, audio = "preferred", bytes = 1_500_000_000, criteria = listOf(SourceProfileCriterionDto("audioTier"))),
      rule("mine", nameKey = "rules.preset.myLanguage", min = 720, max = 1080, audio = "strict", bytes = 4_000_000_000),
      rule("nightly", name = "Nightly", revision = 7, min = 480, audio = "strict"),
    )
    mount(api)
    openSettings(DownloadScope.Season)
    assertNoLegacyRows()
    compose.onNodeWithTag(TagSeriesDownloadRules).assertTextContains("Balanced", substring = true)

    focusUp(TagSeriesDownloadRules)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(seriesRuleTag("smaller"))
      .assertTextContains("Smaller files", substring = true)
      .assertTextContains("480p–720p · prefer my language · up to ~1.5 GB per episode", substring = true)
    compose.onNodeWithTag(seriesRuleTag("best"))
      .assertTextContains("1080p–2160p · prefer my language", substring = true)
    compose.onNodeWithTag(seriesRuleTag("nightly"))
      .assertTextContains("Nightly", substring = true)
      .assertTextContains("480p+ · my language only", substring = true)
    assertNoLegacyRows()
    focusDown(seriesRuleTag("smaller"))
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagSeriesDownloadRules).assertIsFocused()
    compose.onNodeWithTag(TagSeriesDownloadRules).assertTextContains("Smaller files", substring = true)
    focusDown(TagSeriesDownloadAdd)
    press(Key.DirectionCenter)

    assertEquals(listOf("s1e1", "s1e2"), api.bulkDownloads.single().episodes.map { it.id })
    assertEquals(
      """{"profile":{"profileId":"smaller","revision":4}}""",
      json.encodeToString(DownloadSelectionDto.serializer(), api.bulkDownloads.single().selection),
    )
  }

  @Test
  fun `a failed rules fetch disables submit`() {
    val api = ready()
    api.sourceProfilesFailure = ApiFailure.Generic
    mount(api)
    openPanel(waitForPrepare = false)
    focusDown(seriesScopeTag(DownloadScope.Episode))
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagSeriesDownloadRulesUnavailable)
      .assertTextContains("Download rules are unavailable. Ask an administrator.")
    compose.onNodeWithTag(TagSeriesDownloadAdd).assertIsNotEnabled()
    compose.onNodeWithTag(TagSeriesDownloadRules).assertDoesNotExist()
    assertNoLegacyRows()
  }

  @Test
  fun `no offered rule disables submit`() {
    val api = ready()
    api.sourceProfilesValue = emptyList()
    mount(api)
    openPanel(waitForPrepare = false)
    focusDown(seriesScopeTag(DownloadScope.Episode))
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagSeriesDownloadRulesUnavailable).assertIsDisplayed()
    compose.onNodeWithTag(TagSeriesDownloadAdd).assertIsNotEnabled()
  }

  @Test
  fun `a rule without library downloads is not offered`() {
    val api = ready()
    api.sourceProfilesValue = listOf(
      rule("balanced", nameKey = "rules.preset.balanced", operations = listOf("play", "downloadToDevice")),
    )
    mount(api)
    openPanel(waitForPrepare = false)
    focusDown(seriesScopeTag(DownloadScope.Episode))
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagSeriesDownloadRulesUnavailable).assertIsDisplayed()
    compose.onNodeWithTag(seriesRuleTag("balanced")).assertDoesNotExist()
    compose.onNodeWithTag(TagSeriesDownloadAdd).assertIsNotEnabled()
    assertNoLegacyRows()
  }

  @Test
  fun `a remembered offered rule is preselected`() {
    val api = ready()
    api.settingsValue = api.settingsValue.copy(downloadSourceProfile = "smaller")
    api.sourceProfilesValue = listOf(
      rule("balanced", nameKey = "rules.preset.balanced"),
      rule("smaller", nameKey = "rules.preset.smaller", revision = 2),
    )
    mount(api)
    openSettings(DownloadScope.Season)

    compose.onNodeWithTag(TagSeriesDownloadRules).assertTextContains("Smaller files", substring = true)
    assertNoLegacyRows()
    focusUp(TagSeriesDownloadRules)
    press(Key.DirectionCenter)
    focusDown(seriesRuleTag("smaller"))
    compose.onNodeWithTag(seriesRuleTag("smaller")).assertIsFocused().assertIsSelected()
  }

  @Test
  fun `a remembered rule that is not offered falls back to balanced`() {
    val api = ready()
    api.settingsValue = api.settingsValue.copy(downloadSourceProfile = "gone")
    api.sourceProfilesValue = listOf(
      rule("nightly", name = "Nightly"),
      rule("balanced", nameKey = "rules.preset.balanced", revision = 3),
    )
    mount(api)
    openSettings(DownloadScope.Season)

    compose.onNodeWithTag(TagSeriesDownloadRules).assertTextContains("Balanced", substring = true)
    focusUp(TagSeriesDownloadRules)
    press(Key.DirectionCenter)
    focusDown(seriesRuleTag("balanced"))
    compose.onNodeWithTag(seriesRuleTag("balanced")).assertIsSelected()
  }

  @Test
  fun `the first offered rule is preselected when balanced is absent`() {
    val api = ready()
    api.sourceProfilesValue = listOf(
      rule("nightly", name = "Nightly", revision = 5),
      rule("best", nameKey = "rules.preset.best"),
    )
    mount(api)
    openSettings(DownloadScope.Season)

    compose.onNodeWithTag(TagSeriesDownloadRules).assertTextContains("Nightly", substring = true)
    focusUp(TagSeriesDownloadRules)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(seriesRuleTag("nightly")).assertIsFocused().assertIsSelected()
  }

  @Test
  fun `picking another library puts it in the target`() {
    val api = ready()
    mount(api)
    openSettings(DownloadScope.Season)

    focusUp(TagSeriesDownloadLibrary)
    press(Key.DirectionCenter)
    waitFocused(seriesLibraryTag("shows"))
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
    openSettings(DownloadScope.Season)

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
    compose.onNodeWithTag(TagCatalogToLibrary).assertIsFocused()
  }

  @Test
  fun `a second press while the batch posts does not post it twice`() {
    val api = ready()
    api.bulkDownloadGate = CompletableDeferred()
    mount(api)
    openSettings(DownloadScope.Season)

    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSeriesDownloadAdd).assertIsNotEnabled()
    press(Key.DirectionCenter)

    assertEquals(1, api.bulkDownloadCalls)
    api.bulkDownloadGate!!.complete(Unit)
    compose.waitForIdle()
  }

  @Test
  fun `a chosen language is named on the rule summary`() {
    val api = ready()
    api.sourceProfilesValue = listOf(
      rule(
        "english",
        name = "English prefer",
        min = 720,
        max = 1080,
        audio = "preferred",
        preferred = SourceProfileLanguageRefDto(code = "en"),
        criteria = listOf(SourceProfileCriterionDto("audioTier")),
      ),
    )
    mount(api)
    openSettings(DownloadScope.Season)
    focusUp(TagSeriesDownloadRules)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(seriesRuleTag("english"))
      .assertTextContains("prefer English", substring = true)
  }

  @Test
  fun `Back walks the levels and leaves the remote on the opener`() {
    val api = ready()
    mount(api)
    openPanel()

    focusDown(seriesScopeTag(DownloadScope.Season))
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSeriesDownloadRules).assertIsFocused()

    press(Key.DirectionCenter)
    compose.onNodeWithTag(seriesRuleTag("balanced")).assertIsDisplayed()

    back()
    compose.onNodeWithTag(TagSeriesDownloadRules).assertIsFocused()
    back()
    compose.onNodeWithTag(seriesScopeTag(DownloadScope.Season)).assertIsFocused()
    back()
    compose.onNodeWithTag(TagSeriesDownloadPanel).assertDoesNotExist()
    compose.onNodeWithTag(TagCatalogToLibrary).assertIsFocused()
  }

  @Test
  fun `the panel prepares one whole-series answer on open`() {
    val api = ready()
    mount(api)
    openPanel()

    compose.waitUntil(5_000) { api.bulkPrepareCalls == 1 }
    assertEquals(1, api.bulkPrepareCalls)
    val request = api.bulkPrepareRequests.single()
    assertEquals("series", request.scope)
    assertEquals(true, request.specials)
    assertEquals("catalogue", request.origin.kind)
  }

  @Test
  fun `picking another scope does not prepare again`() {
    val api = ready()
    mount(api)
    openPanel()
    val before = api.bulkPrepareCalls

    focusDown(seriesScopeTag(DownloadScope.All))
    press(Key.DirectionCenter)
    back()
    focusUp(seriesScopeTag(DownloadScope.FromEpisode))
    press(Key.DirectionCenter)

    assertEquals(before, api.bulkPrepareCalls)
  }

  @Test
  fun `specials stay off until picked and then join the whole series`() {
    val api = ready()
    mount(api)
    openPanel()

    compose.onNodeWithTag(TagSeriesDownloadSpecials).assertTextContains("1", substring = true)
    focusDown(TagSeriesDownloadSpecials)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSeriesDownloadSpecials).assertIsSelected()
    compose.onNodeWithTag(seriesScopeTag(DownloadScope.All)).assertTextContains("4", substring = true)
  }

  @Test
  fun `a series without a selected episode opens the season picker`() {
    val api = ready()
    mountPanel(
      api,
      BulkOrigin.Catalogue(
        videos = videos,
        media = BulkMediaDto(id = "tt1", metaType = "series"),
      ),
    )
    compose.waitUntil(5_000) { api.bulkPrepareCalls == 1 }

    focusDown(seriesScopeTag(DownloadScope.Season))
    press(Key.DirectionCenter)
    waitFocused(seriesSeasonTag(1))
    compose.onNodeWithTag(seriesSeasonTag(1)).assertTextContains("· 2", substring = true)
    compose.onNodeWithTag(seriesSeasonTag(2)).assertTextContains("· 1", substring = true)
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSeriesDownloadSummary).assertTextContains("1 episode ready", substring = true)
  }

  @Test
  fun `changing the rule prepares the same series again`() {
    val api = ready()
    api.sourceProfilesValue = listOf(
      rule("balanced", nameKey = "rules.preset.balanced"),
      rule("smaller", nameKey = "rules.preset.smaller"),
    )
    mount(api)
    openSettings(DownloadScope.All)
    focusUp(TagSeriesDownloadRules)
    press(Key.DirectionCenter)
    focusDown(seriesRuleTag("smaller"))
    press(Key.DirectionCenter)

    compose.waitUntil(5_000) { api.bulkPrepareCalls == 2 }
    assertEquals("smaller", api.bulkPrepareRequests.last().selection.profile?.profileId)
  }

  @Test
  fun `the skipped screen lists its reasons and its Back row returns to the skipped row`() {
    val api = ready()
    mount(api)
    openSettings(DownloadScope.All)
    focusUp(TagSeriesDownloadSkipped)
    press(Key.DirectionCenter)

    compose.onNodeWithText("S01E03 · Three · not released yet").assertExists()
    waitFocused(TagSeriesDownloadSkippedBack)
    focusDown(TagSeriesDownloadSkippedBack)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSeriesDownloadSkipped).assertIsFocused()
  }

  @Test
  fun `an incomplete listing disables Add and Retry prepares again`() {
    val api = ready()
    val base = api.bulkPrepareAnswer
    api.bulkPrepareAnswer = { request ->
      base(request).copy(listing = BulkPrepareListingDto(complete = false))
    }
    mount(api)
    openSettings(DownloadScope.All)

    compose.onNodeWithTag(TagSeriesDownloadIncomplete).assertExists()
    compose.onNodeWithTag(TagSeriesDownloadAdd).assertIsNotEnabled()
    focusUp(TagSeriesDownloadRetry)
    compose.onNodeWithTag(TagSeriesDownloadRetry).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.bulkPrepareCalls == 2 }
  }

  @Test
  fun `a remote series exposes Source only with a catalogue id and choosing it calls meta once`() {
    val api = ready()
    api.metaValues["series:tt1"] = MetaDto(
      id = "tt1",
      type = "series",
      name = "Catalogue Show",
      videos = videos,
    )
    mountPanel(
      api,
      BulkOrigin.Remote("remote-a", "Server shows", "jellyfin", "remote-series"),
    )
    compose.waitUntil(5_000) { api.bulkPrepareCalls == 1 }

    focusDown(seriesScopeTag(DownloadScope.All))
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSeriesDownloadSource).assertExists()
    focusUp(TagSeriesDownloadSource)
    press(Key.DirectionCenter)
    waitFocused(TagSeriesDownloadSourceLibrary)
    focusDown(TagSeriesDownloadSourceCatalogue)
    press(Key.DirectionCenter)

    compose.waitUntil(5_000) { api.metaRequests.size == 1 }
    compose.waitForIdle()
    assertEquals(
      api.bulkPrepareRequests.joinToString { "${it.origin.kind}:${it.target?.libraryId}" },
      2,
      api.bulkPrepareCalls,
    )
    assertEquals("series" to "tt1", api.metaRequests.single().first to api.metaRequests.single().second)
    assertEquals("catalogue", api.bulkPrepareRequests.last().origin.kind)
  }

  @Test
  fun `a remote series without a catalogue id has no Source row`() {
    val api = ready()
    val base = api.bulkPrepareAnswer
    api.bulkPrepareAnswer = { request ->
      val response = base(request)
      response.copy(series = response.series.copy(catalogueId = null))
    }
    mountPanel(
      api,
      BulkOrigin.Remote("remote-a", "Server shows", "emby", "remote-series"),
    )
    compose.waitUntil(5_000) { api.bulkPrepareCalls == 1 }

    focusDown(seriesScopeTag(DownloadScope.All))
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSeriesDownloadSource).assertDoesNotExist()
  }

  @Test
  fun `remote Add posts the library origin and each remote item id`() {
    val api = ready()
    val base = api.bulkPrepareAnswer
    api.bulkPrepareAnswer = { request ->
      base(request).copy(
        origin = "remote",
        episodes = listOf(
          BulkPreparedEpisodeDto("remote:1", 1, 1, "One", remoteItemId = "item-1", status = "ready"),
          BulkPreparedEpisodeDto("remote:2", 1, 2, "Two", remoteItemId = "item-2", status = "ready"),
        ),
      )
    }
    api.bulkDownloadResult = BulkDownloadResult(added = 2, skipped = 0)
    mountPanel(
      api,
      BulkOrigin.Remote("remote-a", "Server shows", "emby", "remote-series"),
    )
    compose.waitUntil(5_000) { api.bulkPrepareCalls == 1 }
    focusDown(seriesScopeTag(DownloadScope.All))
    press(Key.DirectionCenter)
    focusDown(TagSeriesDownloadAdd)
    press(Key.DirectionCenter)

    val body = api.bulkDownloads.single()
    assertEquals("remote-a", body.origin?.libraryId)
    assertEquals("remote-series", body.origin?.seriesItemId)
    assertEquals(listOf("item-1", "item-2"), body.episodes.map { it.remoteItemId })
    assertEquals(null, body.target)
  }

  @Test
  fun `Back on the first screen cancels a running prepare and closes`() {
    val api = ready()
    api.bulkPrepareGate = CompletableDeferred()
    mount(api)
    openPanel()

    back()
    compose.waitUntil(5_000) { api.bulkPrepareCancelled }
    compose.onNodeWithTag(TagSeriesDownloadPanel).assertDoesNotExist()
  }

  @Test
  fun `Back from Settings returns focus to the row that opened it`() {
    val api = ready()
    mount(api)
    openPanel()
    focusDown(seriesScopeTag(DownloadScope.FromEpisode))
    press(Key.DirectionCenter)

    back()
    compose.onNodeWithTag(seriesScopeTag(DownloadScope.FromEpisode)).assertIsFocused()
  }

  private fun mountPanel(api: FakeTvApi, origin: BulkOrigin, selected: VideoDto? = null) {
    currentApi = api
    compose.setContent {
      SeriesDownloadPanel(
        api = api,
        type = "series",
        title = "Show",
        origin = origin,
        selected = selected,
        settings = api.settingsValue,
        addons = api.addonsValue,
        libraries = api.librariesValue,
        onQueued = { _, _ -> },
        onClose = {},
      )
    }
    compose.waitForIdle()
  }

  private fun rule(
    id: String,
    nameKey: String? = null,
    name: String? = null,
    revision: Int = 1,
    operations: List<String> = listOf("downloadToLibrary"),
    min: Long? = null,
    max: Long? = null,
    audio: String? = null,
    preferred: SourceProfileLanguageRefDto? = null,
    criteria: List<SourceProfileCriterionDto> = emptyList(),
    bytes: Long? = null,
  ): SourceProfileDto {
    val policy = if (min == null && max == null && audio == null && bytes == null) {
      null
    } else {
      SourceProfilePolicyDto(
        constraints = SourceProfileConstraintsDto(
          audio = audio?.let { SourceProfileAudioDto(mode = it, preferred = preferred) },
          heightPixels = if (min == null && max == null) null else SourceProfileRangeDto(min, max),
          bytes = bytes?.let { SourceProfileRangeDto(max = it) },
        ),
        criteria = criteria,
      )
    }
    return SourceProfileDto(
      id = id,
      nameKey = nameKey,
      name = name,
      revision = revision,
      operations = operations,
      policy = policy,
    )
  }
}
