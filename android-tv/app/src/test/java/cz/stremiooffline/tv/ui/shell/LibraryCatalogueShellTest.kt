@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.BrowseResult
import cz.stremiooffline.tv.data.LibraryTitleDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.TagCatalogPrimary
import cz.stremiooffline.tv.ui.detail.TagDetailPrimary
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class LibraryCatalogueShellTest {

  @get:Rule val compose = createEmptyComposeRule()

  private lateinit var scenario: ActivityScenario<ComponentActivity>
  private val path = "It/It.mkv"

  @Before
  fun launchHost() {
    scenario = ActivityScenario.launch(
      Intent(ApplicationProvider.getApplicationContext(), ComponentActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
  }

  @After
  fun closeHost() {
    scenario.close()
  }

  private fun api() = FakeTvApi().apply {
    settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en")
    pages[null] = BrowseResult(
      path = "",
      items = listOf(BrowseItem.Folder(path = "It", name = "It", fileCount = 1)),
      total = 1,
      pending = false,
    )
    pages["It"] = BrowseResult(
      path = "It",
      items = listOf(BrowseItem.File(path = path, label = "It.mkv")),
      total = 1,
      pending = false,
    )
    metaValues["movie:tt1"] = MetaDto(id = "tt1", type = "movie", name = "It")
  }

  private fun mount(api: FakeTvApi) {
    scenario.onActivity { activity ->
      activity.setContent { Shell(start = Section.Library, api = api, username = "demo", onSignOut = {}) }
    }
    compose.waitForIdle()
    compose.onNodeWithText("Files").performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
  }

  private fun openIt() {
    compose.onNodeWithTag("It").assertIsFocused()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
  }

  private fun focused(tag: String): Boolean =
    compose.onAllNodes(isFocused()).fetchSemanticsNodes()
      .any { it.config.getOrElse(SemanticsProperties.TestTag) { "" } == tag }

  @Test
  fun `a bound library file opens the catalogue and Back restores its card`() {
    val api = api().apply {
      libraryTitleValues[path] = LibraryTitleDto(type = "movie", id = "tt1", name = "It")
    }
    mount(api)

    openIt()

    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(TagCatalogPrimary).assertExists() }.isSuccess
    }
    compose.onNodeWithTag(TagDetailPrimary).assertDoesNotExist()
    assertEquals(listOf(path), api.libraryTitleRequests)

    scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    compose.waitUntil(5_000) { focused("It") }
  }

  @Test
  fun `an unbound library file opens the library detail`() {
    mount(api())

    openIt()

    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(TagDetailPrimary).assertExists() }.isSuccess
    }
    compose.onNodeWithTag(TagCatalogPrimary).assertDoesNotExist()
  }
}
