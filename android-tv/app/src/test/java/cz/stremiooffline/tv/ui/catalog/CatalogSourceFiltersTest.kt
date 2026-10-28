@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.SourceProfileDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Sorting and filtering the sources of a title from the remote, the TV side of the web's bar. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class CatalogSourceFiltersTest {

  @get:Rule val compose = createComposeRule()

  private val played = mutableListOf<PlayTarget>()

  private fun settings() =
    SettingsResponse(uiLanguage = "en", audioLanguage = "en", streamSort = "recommended", realDebridConfigured = true)

  private fun stream(sourceId: String, title: String, addonName: String) =
    StreamDto(sourceId = sourceId, kind = "remote", playable = true, title = title, addonName = addonName)

  private fun movieArgs() = CatalogDetailArgs(MetaDto(id = "tt1", type = "movie", name = "It"), "Cinemeta", "movie")

  private fun mount(api: FakeTvApi, args: CatalogDetailArgs = movieArgs()) {
    compose.setContent {
      CatalogDetailScreen(api = api, args = args, imageUrl = { null }, onPlay = { played += it }, onBack = {})
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

  /** Walk left from the Sources button back to the action row's first button. */
  private fun focusFromRight(tag: String) {
    repeat(6) {
      if (focused(tag)) return
      press(Key.DirectionLeft)
    }
    compose.onNodeWithTag(tag).assertIsFocused()
  }

  private fun openSources() {
    focusFromLeft(TagCatalogSources)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSourcesPanel).assertExists()
  }

  /** Two addons offering one stream each, one Czech and one English. */
  private fun twoAddons(api: FakeTvApi) {
    api.settingsValue = settings()
    api.streamsValues["movie:tt1"] = listOf(
      stream("srcA", "Czech 1 GB", "Alpha"),
      stream("srcB", "English 8 GB", "Beta"),
    )
  }

  @Test
  fun `the filter chips take the focus in order`() {
    val api = FakeTvApi()
    twoAddons(api)
    mount(api)
    compose.waitForIdle()

    openSources()
    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()
    press(Key.DirectionUp)
    compose.onNodeWithTag(sourceFilterTag("sort")).assertIsFocused()
    press(Key.DirectionRight)
    compose.onNodeWithTag(sourceFilterTag("addon")).assertIsFocused()
    press(Key.DirectionRight)
    compose.onNodeWithTag(sourceFilterTag("language")).assertIsFocused()
    press(Key.DirectionLeft)
    compose.onNodeWithTag(sourceFilterTag("addon")).assertIsFocused()
  }

  @Test
  fun `OK on the sorting chip opens its list with the current choice ticked and focused`() {
    val api = FakeTvApi()
    api.sourceProfilesValue = listOf(SourceProfileDto(id = "balanced", nameKey = "rules.preset.balanced"))
    twoAddons(api)
    mount(api)
    compose.waitUntil(5_000) { api.sourceProfilesCalls >= 1 }
    compose.waitForIdle()

    openSources()
    press(Key.DirectionUp)
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagSourceFilterOptions).assertExists()
    compose.onNodeWithTag(sourceFilterOptionTag(0)).assertIsFocused()
    compose.onNodeWithTag(sourceFilterOptionTag(0)).assertTextContains("Balanced", substring = true)
    compose.onNodeWithTag(sourceFilterOptionTag(0)).assertTextContains("✓", substring = true)
  }

  @Test
  fun `the sort choices list the rule names before the fixed sorts`() {
    val api = FakeTvApi()
    api.sourceProfilesValue = listOf(
      SourceProfileDto(id = "balanced", nameKey = "rules.preset.balanced"),
      SourceProfileDto(id = "nightly", name = "Nightly"),
    )
    twoAddons(api)
    mount(api)
    compose.waitUntil(5_000) { api.sourceProfilesCalls >= 1 }
    compose.waitForIdle()

    openSources()
    press(Key.DirectionUp)
    press(Key.DirectionCenter)

    compose.onNodeWithTag(sourceFilterOptionTag(0)).assertTextContains("Balanced", substring = true)
    compose.onNodeWithTag(sourceFilterOptionTag(1)).assertTextContains("Nightly", substring = true)
    compose.onNodeWithTag(sourceFilterOptionTag(2)).assertTextContains("Largest first", substring = true)
    compose.onNodeWithTag(sourceFilterOptionTag(3)).assertTextContains("Smallest first", substring = true)
    compose.onNodeWithTag(sourceFilterOptionTag(4)).assertTextContains("By addon priority", substring = true)
  }

  @Test
  fun `choosing Largest first reorders the rows`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    // The preferred language is the smaller release, so recommended and largest disagree.
    api.streamsValues["movie:tt1"] = listOf(
      stream("srcA", "English 1 GB", "Alpha"),
      stream("srcB", "Czech 8 GB", "Beta"),
    )
    mount(api)
    compose.waitForIdle()

    openSources()
    compose.onNodeWithTag(sourceRowTag(0)).assertTextContains("English 1 GB")

    press(Key.DirectionUp)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(sourceFilterOptionTag(0)).assertTextContains("Largest first", substring = true)
    press(Key.DirectionCenter)

    compose.onNodeWithTag(sourceFilterTag("sort")).assertIsFocused()
    compose.onNodeWithTag(sourceFilterTag("sort")).assertTextContains("Largest first", substring = true)
    compose.onNodeWithTag(sourceRowTag(0)).assertTextContains("Czech 8 GB")
    compose.onNodeWithTag(sourceRowTag(1)).assertTextContains("English 1 GB")
  }

  @Test
  fun `choosing an addon hides the other addon's rows and updates the count`() {
    val api = FakeTvApi()
    twoAddons(api)
    mount(api)
    compose.waitForIdle()

    openSources()
    compose.onNodeWithTag(TagSourcesCount).assertTextContains("2 of 2")

    press(Key.DirectionUp)
    press(Key.DirectionRight)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(sourceFilterOptionTag(0)).assertIsFocused()
    press(Key.DirectionDown)
    compose.onNodeWithTag(sourceFilterOptionTag(1)).assertIsFocused()
    press(Key.DirectionCenter)

    compose.onNodeWithTag(sourceFilterTag("addon")).assertTextContains("Alpha", substring = true)
    compose.onNodeWithTag(sourceRowTag(0)).assertTextContains("Alpha")
    compose.onNodeWithTag(sourceRowTag(1)).assertDoesNotExist()
    compose.onNodeWithTag(TagSourcesCount).assertTextContains("1 of 2")
  }

  private fun withLibraryCopy(api: FakeTvApi) {
    api.localStreamsResult = listOf(
      StreamDto(
        sourceId = "loc1", kind = "library", playable = true, name = "Heat.mkv", title = "Heat.mkv",
        localPath = "Filmy/Heat (1995)/Heat.mkv", libraryName = "Filmy",
      ),
    )
  }

  /** Opens the addon menu and moves to the option [index]. */
  private fun openAddonMenuAt(index: Int) {
    press(Key.DirectionUp)
    press(Key.DirectionRight)
    press(Key.DirectionCenter)
    repeat(index) { press(Key.DirectionDown) }
    compose.onNodeWithTag(sourceFilterOptionTag(index)).assertIsFocused()
    press(Key.DirectionCenter)
  }

  @Test
  fun `the addon filter offers the library copies as Local files and shows them alone`() {
    val api = FakeTvApi()
    twoAddons(api)
    withLibraryCopy(api)
    mount(api)
    compose.waitForIdle()

    openSources()
    // All, Local files, then the addons.
    openAddonMenuAt(1)

    compose.onNodeWithTag(sourceFilterTag("addon")).assertTextContains("Local files", substring = true)
    compose.onNodeWithTag(sourceRowTag(0)).assertTextContains("Heat.mkv")
    compose.onNodeWithTag(sourceRowTag(1)).assertDoesNotExist()
  }

  @Test
  fun `choosing a named addon leaves the library copy out of the list`() {
    val api = FakeTvApi()
    twoAddons(api)
    withLibraryCopy(api)
    mount(api)
    compose.waitForIdle()

    openSources()
    compose.onNodeWithTag(sourceRowTag(0)).assertTextContains("Heat.mkv")
    openAddonMenuAt(2)

    compose.onNodeWithTag(sourceFilterTag("addon")).assertTextContains("Alpha", substring = true)
    compose.onNodeWithTag(sourceRowTag(0)).assertTextContains("Alpha")
    compose.onNodeWithTag(sourceRowTag(1)).assertDoesNotExist()
  }

  @Test
  fun `choosing a language filters the rows`() {
    val api = FakeTvApi()
    twoAddons(api)
    mount(api)
    compose.waitForIdle()

    openSources()
    press(Key.DirectionUp)
    press(Key.DirectionRight)
    press(Key.DirectionRight)
    compose.onNodeWithTag(sourceFilterTag("language")).assertIsFocused()
    press(Key.DirectionCenter)
    compose.onNodeWithTag(sourceFilterOptionTag(0)).assertIsFocused()
    press(Key.DirectionDown)
    compose.onNodeWithTag(sourceFilterOptionTag(1)).assertTextContains("CZ", substring = true)
    press(Key.DirectionCenter)

    compose.onNodeWithTag(sourceFilterTag("language")).assertTextContains("CZ", substring = true)
    compose.onNodeWithTag(sourceRowTag(0)).assertTextContains("Czech 1 GB")
    compose.onNodeWithTag(sourceRowTag(1)).assertDoesNotExist()
    compose.onNodeWithTag(TagSourcesCount).assertTextContains("1 of 2")
  }

  @Test
  fun `the default source follows the filtered list`() {
    val api = FakeTvApi()
    twoAddons(api)
    mount(api)
    compose.waitForIdle()

    openSources()
    // Recommended puts the 8 GB Beta row first, so Beta is the default.
    compose.onNodeWithTag(sourceRowTag(0)).assertTextContains("English 8 GB")

    press(Key.DirectionUp)
    press(Key.DirectionRight)
    press(Key.DirectionCenter)
    press(Key.DirectionDown)
    press(Key.DirectionCenter)

    // Only Alpha is left, so the default is Alpha's own row now.
    compose.onNodeWithTag(sourceRowTag(0)).assertTextContains("Czech 1 GB")
    compose.onNodeWithTag(sourceRowTag(0)).assertTextContains("Default", substring = true)

    // Play, with nothing picked, plays the filtered default.
    press(Key.Back)
    compose.onNodeWithTag(TagSourcesPanel).assertDoesNotExist()
    focusFromRight(TagCatalogPrimary)
    press(Key.DirectionCenter)
    assertEquals(listOf("srcA"), played.map { it.sourceId })
  }

  @Test
  fun `the filters reset when the episode changes`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    val v1 = VideoDto(id = "tt1:1:1", title = "One", season = 1, episode = 1)
    val v2 = VideoDto(id = "tt1:1:2", title = "Two", season = 1, episode = 2)
    api.metaValues["series:tt1"] = MetaDto(id = "tt1", type = "series", name = "Show", videos = listOf(v1, v2))
    api.streamsValues["series:tt1:1:1"] = listOf(stream("srcA", "Czech 1 GB", "Alpha"), stream("srcB", "English 8 GB", "Beta"))
    api.streamsValues["series:tt1:1:2"] = listOf(stream("srcA2", "Czech 1 GB", "Alpha"), stream("srcB2", "English 8 GB", "Beta"))
    mount(api, CatalogDetailArgs(MetaDto(id = "tt1", type = "series", name = "Show"), "Cinemeta", "series"))
    compose.waitForIdle()

    openSources()
    press(Key.DirectionUp)
    press(Key.DirectionRight)
    press(Key.DirectionCenter)
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(sourceFilterTag("addon")).assertTextContains("Alpha", substring = true)

    press(Key.Back)
    compose.onNodeWithTag(TagSourcesPanel).assertDoesNotExist()

    press(Key.DirectionDown)
    compose.onNodeWithTag(episodeCardTag(v1)).assertIsFocused()
    press(Key.DirectionRight)
    compose.onNodeWithTag(episodeCardTag(v2)).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.streamsRequests.contains("series:tt1:1:2") }
    compose.waitForIdle()

    openSources()
    compose.onNodeWithTag(sourceFilterTag("addon")).assertTextContains("All", substring = true)
    compose.onNodeWithTag(TagSourcesCount).assertTextContains("2 of 2")
  }

  @Test
  fun `Back leaves the nested list before the panel`() {
    val api = FakeTvApi()
    twoAddons(api)
    mount(api)
    compose.waitForIdle()

    openSources()
    press(Key.DirectionUp)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSourceFilterOptions).assertExists()

    press(Key.Back)
    compose.onNodeWithTag(TagSourceFilterOptions).assertDoesNotExist()
    compose.onNodeWithTag(sourceFilterTag("sort")).assertIsFocused()
    compose.onNodeWithTag(TagSourcesPanel).assertExists()

    press(Key.Back)
    compose.onNodeWithTag(TagSourcesPanel).assertDoesNotExist()
  }
}
