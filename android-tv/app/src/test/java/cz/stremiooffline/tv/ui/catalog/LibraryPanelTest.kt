@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.activity.ComponentActivity
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.AddonDownloadSettingsDto
import cz.stremiooffline.tv.data.AddonDto
import cz.stremiooffline.tv.data.AddonManifestDto
import cz.stremiooffline.tv.data.DownloadTargetSettingsDto
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.FakeTvApi
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Choosing the library a download goes to on the TV. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class LibraryPanelTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private fun mount(api: FakeTvApi) {
    compose.setContent {
      CatalogDetailScreen(
        api = api,
        args = CatalogDetailArgs(MetaDto(id = "tt1", type = "movie", name = "It"), "alpha", "movie"),
        imageUrl = { null },
        onPlay = {},
        onBack = {},
      )
    }
  }

  private fun ready(libraries: List<LibraryDto>): FakeTvApi {
    val api = FakeTvApi()
    api.settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", realDebridConfigured = true)
    api.streamsValues["movie:tt1"] = listOf(
      StreamDto(sourceId = "s1", kind = "torrent", playable = false, title = "Czech 8 GB", addonKey = "alpha", addonName = "alpha"),
    )
    api.librariesValue = libraries
    return api
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun focused(tag: String): Boolean =
    compose.onAllNodes(isFocused()).fetchSemanticsNodes()
      .any { it.config.getOrElse(SemanticsProperties.TestTag) { "" } == tag }

  private fun focusToLibrary() {
    repeat(6) {
      if (focused(TagCatalogToLibrary)) return
      press(Key.DirectionRight)
    }
    compose.onNodeWithTag(TagCatalogToLibrary).assertIsFocused()
  }

  /** The ↓ button opens the title panel on the source on screen; confirming it runs today's queue. */
  private fun confirmSelectedSource() {
    compose.onNodeWithTag(TagTitleDownloadPanel).assertExists()
    compose.onNodeWithTag(TagTitleDownloadSource).assertIsFocused()
    press(Key.DirectionCenter)
  }

  @Test
  fun `two writable libraries open a panel on the addon default, and Back returns`() {
    val api = ready(
      listOf(
        LibraryDto(id = "movies", name = "Movies", type = "movie", writable = true),
        LibraryDto(id = "shows", name = "Shows", type = "movie", writable = true),
      ),
    )
    api.addonsValue = listOf(
      AddonDto(
        key = "alpha",
        manifest = AddonManifestDto(id = "alpha", name = "Alpha"),
        downloadSettings = AddonDownloadSettingsDto(movie = DownloadTargetSettingsDto(libraryId = "shows")),
      ),
    )
    mount(api)
    compose.waitForIdle()

    focusToLibrary()
    press(Key.DirectionCenter)
    confirmSelectedSource()
    compose.onNodeWithTag(TagCatalogLibraryPanel).assertExists()
    compose.onNodeWithTag(libraryOptionTag("shows")).assertIsFocused()

    compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()
    compose.onNodeWithTag(TagCatalogLibraryPanel).assertDoesNotExist()
    compose.onNodeWithTag(TagCatalogToLibrary).assertIsFocused()
  }

  @Test
  fun `picking a library queues with its id as the target`() {
    val api = ready(
      listOf(
        LibraryDto(id = "movies", name = "Movies", type = "movie", writable = true),
        LibraryDto(id = "shows", name = "Shows", type = "movie", writable = true),
      ),
    )
    mount(api)
    compose.waitForIdle()

    focusToLibrary()
    press(Key.DirectionCenter)
    confirmSelectedSource()
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    compose.waitForIdle()

    assertEquals("shows", api.queuedTargets.last()?.libraryId)
    compose.onNodeWithTag(TagCatalogLibraryPanel).assertDoesNotExist()
  }

  @Test
  fun `one writable library queues straight into it`() {
    val api = ready(listOf(LibraryDto(id = "movies", name = "Movies", type = "movie", writable = true)))
    mount(api)
    compose.waitForIdle()

    focusToLibrary()
    press(Key.DirectionCenter)
    confirmSelectedSource()
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogLibraryPanel).assertDoesNotExist()
    assertEquals("movies", api.queuedTargets.last()?.libraryId)
  }

  @Test
  fun `no writable library says there is nowhere to save`() {
    val api = ready(listOf(LibraryDto(id = "movies", name = "Movies", type = "movie", writable = false)))
    mount(api)
    compose.waitForIdle()

    focusToLibrary()
    press(Key.DirectionCenter)
    confirmSelectedSource()
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogMessage).assertTextContains(
      compose.activity.getString(cz.stremiooffline.tv.R.string.tv_no_library_to_save),
    )
    assertEquals(emptyList<Any>(), api.queuedTargets.filterNotNull())
  }

  /** The web's `ruleTarget`: with no addon rule the library the account flagged as its default
   *  for this kind is the one the panel opens on. */
  @Test
  fun `without an addon rule the library flagged as the movie default is preselected`() {
    val api = ready(
      listOf(
        LibraryDto(id = "movies", name = "Movies", type = "movie", writable = true),
        LibraryDto(id = "shows", name = "Shows", type = "movie", writable = true, defaultMovie = true),
      ),
    )
    mount(api)
    compose.waitForIdle()

    focusToLibrary()
    press(Key.DirectionCenter)
    confirmSelectedSource()
    compose.onNodeWithTag(TagCatalogLibraryPanel).assertExists()
    compose.onNodeWithTag(libraryOptionTag("shows")).assertIsFocused()
  }

  /** With neither an addon rule nor a flagged library, the first writable one of the right type
   *  is the offer, and it is the panel's selection. */
  @Test
  fun `without any default the first writable library of the right type is preselected`() {
    val api = ready(
      listOf(
        LibraryDto(id = "series", name = "Shows", type = "series", writable = true, defaultSeries = true),
        LibraryDto(id = "movies", name = "Movies", type = "movie", writable = true),
        LibraryDto(id = "films", name = "Films", type = "movie", writable = true),
      ),
    )
    mount(api)
    compose.waitForIdle()

    focusToLibrary()
    press(Key.DirectionCenter)
    confirmSelectedSource()

    compose.onNodeWithTag(libraryOptionTag("movies")).assertIsFocused()
    compose.onNodeWithTag(libraryOptionTag("series")).assertDoesNotExist()
  }
}
