@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
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
import cz.stremiooffline.tv.data.RelatedTitleDto
import cz.stremiooffline.tv.data.TitleExtrasDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.TagCatalogPrimary
import cz.stremiooffline.tv.ui.detail.TagDetailPrimary
import cz.stremiooffline.tv.ui.detail.relatedTitleTag
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
class LocalDetailRelatedShellTest {

  @get:Rule val compose = createEmptyComposeRule()

  private lateinit var scenario: ActivityScenario<ComponentActivity>

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

  @Test
  fun `Back from related leaves the local detail underneath`() {
    val path = "It/It.mkv"
    val api = FakeTvApi().apply {
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
      libraryTitleValues[path] = LibraryTitleDto(type = "movie", id = "tt1", name = "It")
      titleExtrasValue = TitleExtrasDto(
        related = listOf(RelatedTitleDto(type = "movie", id = "tt2", name = "Related")),
      )
      metaValues["movie:tt2"] = MetaDto(id = "tt2", type = "movie", name = "Related")
    }
    scenario.onActivity { activity ->
      activity.setContent { Shell(start = Section.Library, api = api, username = "demo", onSignOut = {}) }
    }
    compose.waitForIdle()

    compose.onNodeWithText("Files").performSemanticsAction(SemanticsActions.RequestFocus)
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.onNodeWithTag("It").performSemanticsAction(SemanticsActions.RequestFocus)
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitUntil(5_000) { api.titleExtrasRequests.isNotEmpty() }
    compose.waitForIdle()
    compose.onNodeWithTag(relatedTitleTag("tt2")).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogPrimary).assertExists()
    assertEquals("movie:tt1", api.titleExtrasRequests.first().let { "${it.first}:${it.second}" })

    scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogPrimary).assertDoesNotExist()
    compose.onNodeWithTag(TagDetailPrimary).assertExists()
  }
}
