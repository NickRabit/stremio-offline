@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.activity.ComponentActivity
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.BulkDownloadResult
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.ProgressEntryDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.SourceProfileDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.ui.FakeTvApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The ↓ button's panel for one film or the selected episode. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class TitleDownloadPanelTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private fun movieApi(): FakeTvApi {
    val api = FakeTvApi()
    api.settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", realDebridConfigured = true)
    api.librariesValue = listOf(LibraryDto(id = "movies", name = "Movies", type = "movie", writable = true))
    api.streamsValues["movie:tt1"] = listOf(
      StreamDto(sourceId = "srcA", kind = "remote", playable = true, name = "Director's cut"),
    )
    api.sourceProfilesValue = listOf(
      rule("balanced", nameKey = "rules.preset.balanced"),
      rule("smaller", nameKey = "rules.preset.smaller", revision = 4),
    )
    return api
  }

  private fun mountMovie(api: FakeTvApi) {
    compose.setContent {
      CatalogDetailScreen(
        api = api,
        args = CatalogDetailArgs(MetaDto(id = "tt1", type = "movie", name = "It"), "Cinemeta", "movie"),
        imageUrl = { null },
        onPlay = {},
        onBack = {},
      )
    }
    compose.waitForIdle()
  }

  private fun mountSeries(api: FakeTvApi) {
    compose.setContent {
      CatalogDetailScreen(
        api = api,
        args = CatalogDetailArgs(
          MetaDto(
            id = "tt1",
            type = "series",
            name = "Show",
            videos = listOf(VideoDto(id = "s1e2", season = 1, episode = 2, title = "Pilot", released = "2020-01-01")),
          ),
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
    repeat(8) {
      if (focused(tag)) return
      press(Key.DirectionDown)
    }
    compose.onNodeWithTag(tag).assertIsFocused()
  }

  private fun focusUp(tag: String) {
    repeat(8) {
      if (focused(tag)) return
      press(Key.DirectionUp)
    }
    compose.onNodeWithTag(tag).assertIsFocused()
  }

  private fun openPanel() {
    focusRight(TagCatalogToLibrary)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagTitleDownloadPanel).assertExists()
  }

  /** Selects [id] and posts it. The row only selects; Add is what queues. */
  private fun chooseRule(id: String) {
    focusDown(seriesRuleTag(id))
    press(Key.DirectionCenter)
    focusDown(TagTitleDownloadAdd)
    press(Key.DirectionCenter)
  }

  @Test
  fun `the download button opens the panel and does not queue`() {
    val api = movieApi()
    mountMovie(api)
    openPanel()

    compose.onNodeWithText("Download film").assertIsDisplayed()
    compose.onNodeWithTag(TagTitleDownloadSource).assertTextContains("Selected source", substring = true)
    compose.onNodeWithTag(TagTitleDownloadSource).assertTextContains("Director's cut", substring = true)
    assertEquals(0, api.downloadCalls)
    assertEquals(0, api.bulkDownloadCalls)
  }

  @Test
  fun `choosing the selected source queues that source`() {
    val api = movieApi()
    mountMovie(api)
    openPanel()

    compose.onNodeWithTag(TagTitleDownloadSource).assertIsDisplayed()
    focusUp(TagTitleDownloadSource)
    press(Key.DirectionCenter)

    assertEquals(listOf("srcA"), api.queuedSourceIds)
    assertEquals(0, api.bulkDownloadCalls)
  }

  @Test
  fun `an explicit pick focuses the selected source first`() {
    val api = movieApi()
    mountMovie(api)

    focusRight(TagCatalogSources)
    press(Key.DirectionCenter)
    press(Key.DirectionCenter)

    openPanel()
    compose.onNodeWithTag(TagTitleDownloadSource).assertIsFocused()
    compose.onNodeWithTag(seriesRuleTag("balanced")).assertIsNotFocused()
    assertEquals(0, api.downloadCalls)
  }

  @Test
  fun `the panel always opens on the selected source, even without an explicit pick`() {
    val api = movieApi()
    mountMovie(api)
    openPanel()

    compose.onNodeWithTag(TagTitleDownloadSource).assertIsFocused()
    compose.onNodeWithTag(seriesRuleTag("balanced")).assertIsNotFocused()
  }

  @Test
  fun `a rule for a film posts one movie entry with no numbers`() {
    val api = movieApi()
    mountMovie(api)
    openPanel()
    chooseRule("smaller")

    val body = api.bulkDownloads.single()
    assertEquals("movie", body.type)
    assertEquals("It", body.title)
    val episode = body.episodes.single()
    assertEquals("tt1", episode.id)
    assertNull(episode.season)
    assertNull(episode.episode)
    assertEquals("It", episode.title)
    assertEquals("smaller", body.selection.profile?.profileId)
    assertEquals(4, body.selection.profile?.revision)
    assertEquals("movie", body.media.metaType)
    assertEquals("tt1", body.media.id)
    assertEquals(0, api.downloadCalls)
  }

  @Test
  fun `a rule for an episode posts that episode`() {
    val api = FakeTvApi()
    api.settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", realDebridConfigured = true)
    api.librariesValue = listOf(LibraryDto(id = "shows", name = "TV shows", type = "series", writable = true))
    api.progressEntries = listOf(
      ProgressEntryDto(
        key = "series:tt1",
        position = 60.0,
        duration = 600.0,
        title = "Show",
        series = ProgressEntryDto.Series(id = "tt1", name = "Show", season = 1, episode = 2),
      ),
    )
    api.streamsValues["series:s1e2"] = listOf(
      StreamDto(sourceId = "srcE", kind = "remote", playable = true, name = "Episode cut"),
    )
    api.sourceProfilesValue = listOf(
      rule("balanced", nameKey = "rules.preset.balanced"),
      rule("smaller", nameKey = "rules.preset.smaller", revision = 4),
    )
    mountSeries(api)
    openPanel()

    compose.onNodeWithText("Download episode").assertIsDisplayed()
    chooseRule("smaller")

    val body = api.bulkDownloads.single()
    assertEquals("series", body.type)
    val episode = body.episodes.single()
    assertEquals("s1e2", episode.id)
    assertEquals(1, episode.season)
    assertEquals(2, episode.episode)
    assertEquals("Pilot", episode.title)
    assertEquals("smaller", body.selection.profile?.profileId)
    assertEquals(4, body.selection.profile?.revision)
    assertEquals("series", body.media.metaType)
    assertEquals(0, api.downloadCalls)
  }

  @Test
  fun `a queued film reuses the bulk notice and returns to the button`() {
    val api = movieApi()
    api.bulkDownloadResult = BulkDownloadResult(added = 1, skipped = 1)
    mountMovie(api)
    openPanel()
    chooseRule("smaller")

    compose.onNodeWithTag(TagTitleDownloadPanel).assertDoesNotExist()
    compose.onNodeWithTag(TagCatalogMessage).assertTextContains("1 episode added to the queue. 1 skipped, already queued.")
    compose.onNodeWithTag(TagCatalogToLibrary).assertIsFocused()
  }

  @Test
  fun `Back closes the panel and returns to the download button`() {
    val api = movieApi()
    mountMovie(api)
    openPanel()

    back()
    compose.onNodeWithTag(TagTitleDownloadPanel).assertDoesNotExist()
    compose.onNodeWithTag(TagCatalogToLibrary).assertIsFocused()
  }

  private fun rule(
    id: String,
    nameKey: String? = null,
    name: String? = null,
    revision: Int = 1,
    operations: List<String> = listOf("downloadToLibrary"),
  ) = SourceProfileDto(id = id, nameKey = nameKey, name = name, revision = revision, operations = operations)
}
