@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.library

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.RemoteProviderIdsDto
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteItemsPageDto
import cz.stremiooffline.tv.data.RemoteLibraryDto
import cz.stremiooffline.tv.data.GlobalSearchLibraryDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.RemoteDetailData
import cz.stremiooffline.tv.ui.search.LibrarySearchScope
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The servers half draws the section's one compact header and toolbar: its own path once, a search
 * that stays closed until it is asked for, and no second large heading over the cards.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class RemoteLibraryChromeTest {

  @get:Rule val compose = createEmptyComposeRule()

  private lateinit var scenario: ActivityScenario<ComponentActivity>
  private var host: ComponentActivity? = null

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

  private fun folder(id: String, name: String) = RemoteItemDto(id = id, name = name, type = "folder")

  private fun api() = FakeTvApi().apply {
    remoteLibrariesValue = listOf(RemoteLibraryDto(id = "rlibA", name = "Server", provider = "emby", type = "mixed"))
    remoteBrowsePages["rlibA||"] = RemoteItemsPageDto(items = listOf(folder("f1", "Shows")), total = 1)
    remoteBrowsePages["rlibA|f1|"] = RemoteItemsPageDto(items = listOf(folder("f2", "Season 1")), total = 1)
  }

  /** The half on its own, the way the section embeds it, with the section header above it. */
  private fun mountEmbedded(
    api: FakeTvApi,
    searchEverywhereEnabled: Boolean = false,
    onOpenSearch: (LibrarySearchScope) -> Unit = {},
  ) {
    scenario.onActivity { activity ->
      host = activity
      activity.setContent {
        LibraryRoute(
          api = api,
          onOpenDetail = {},
          searchEverywhereEnabled = searchEverywhereEnabled,
          pendingDelayMs = 10L,
          onOpenSearch = onOpenSearch,
        )
      }
    }
    compose.waitForIdle()
    compose.onNodeWithText("Media servers").performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()
  }

  private fun focusOn(tag: String) {
    compose.onNodeWithTag(tag).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
  }

  /** Opens one library and waits for its first page. */
  private fun openLibrary(api: FakeTvApi) {
    compose.waitUntil(5_000) { api.remoteLibrariesCalls > 0 }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()
    compose.onNodeWithTag(remoteLibraryTag("rlibA")).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.remoteBrowseRequests.isNotEmpty() }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()
  }

  @Test
  fun `the picker keeps the section's one heading and the first card starts high`() {
    val api = api()
    mountEmbedded(api)
    compose.waitUntil(5_000) { api.remoteLibrariesCalls > 0 }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()

    // The section's heading names the page; the picker adds no second large heading of its own.
    compose.onNodeWithTag(TagLibraryHeaderTitle).assertExists()
    compose.onNodeWithText(ApplicationProvider.getApplicationContext<android.content.Context>().getString(R.string.media_server_pick_title))
      .assertDoesNotExist()
    // The root has no path of its own and nothing to search, so neither line is drawn.
    compose.onNodeWithTag(TagRemoteBreadcrumb).assertDoesNotExist()
    compose.onNodeWithTag(TagLibrarySearchAction).assertDoesNotExist()
    compose.onNodeWithTag(TagLibrarySearchField).assertDoesNotExist()

    // The qualifier fixes the density at 2, so 180dp is 360px.
    val top = compose.onNodeWithTag(remoteLibraryTag("rlibA")).fetchSemanticsNode().boundsInRoot.top
    assertTrue("the first card starts at $top px, not below 180dp", top < 180f * 2f)
  }

  @Test
  fun `the level names its path once and its search submits only when asked`() {
    val api = api()
    mountEmbedded(api)
    openLibrary(api)

    // One path line, the library's name, and no repeated level title beside it.
    compose.onNodeWithTag(TagRemoteBreadcrumb).assert(hasText("Server"))
    compose.onNodeWithText("Server").assertExists()
    // The type button and the search live in the one compact toolbar row.
    compose.onNodeWithTag(TagLibraryToolbar).assertExists()
    compose.onNodeWithTag(TagLibraryTypeFilter)
      .assert(hasText(ApplicationProvider.getApplicationContext<android.content.Context>().getString(R.string.tv_library_type_all)))

    compose.onNodeWithTag(TagLibrarySearchField).assertDoesNotExist()
    focusOn(TagLibrarySearchAction)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagLibrarySearchField).assertIsFocused()
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagLibrarySearchInput).performTextInput("Shows")
    compose.waitForIdle()
    assertTrue("nothing is asked before the submit", api.remoteBrowseRequests.none { it.search == "Shows" })
    compose.onNodeWithTag(TagLibrarySearchInput).performImeAction()
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()

    assertEquals("Shows", api.remoteBrowseRequests.last().search)
    // The action keeps the Catalog chip's own label; the narrowing lives in the level.
    compose.onNodeWithTag(TagLibrarySearchField).assertDoesNotExist()
    compose.onNodeWithTag(TagLibrarySearchAction).assert(hasText("Search"))
    assertEquals(1, api.remoteBrowseRequests.count { it.search == "Shows" })
  }

  @Test
  fun `back closes the open editor before the level is left`() {
    val api = api()
    mountEmbedded(api)
    openLibrary(api)

    focusOn(TagLibrarySearchAction)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagLibrarySearchField).assertExists()

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()

    // The editor is gone and the level is not: the path is still the library's own.
    compose.onNodeWithTag(TagLibrarySearchField).assertDoesNotExist()
    compose.onNodeWithTag(TagRemoteBreadcrumb).assert(hasText("Server"))
    compose.onNodeWithTag(TagLibrarySearchAction).assertIsFocused()
  }

  @Test
  fun `a child level starts without the parent's search and back restores it`() {
    val api = api()
    mountEmbedded(api)
    openLibrary(api)

    focusOn(TagLibrarySearchAction)
    press(Key.DirectionCenter)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagLibrarySearchInput).performTextInput("Shows")
    compose.onNodeWithTag(TagLibrarySearchInput).performImeAction()
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()

    // A folder opened from the narrowed listing is the whole folder, with no query of its own.
    focusOn(remoteItemTag("f1"))
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.remoteBrowseRequests.any { it.parentId == "f1" } }
    compose.waitForIdle()
    assertEquals(null, api.remoteBrowseRequests.last { it.parentId == "f1" }.search)

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()

    // Back lands on the parent's own narrowed list.
    compose.onNodeWithTag(TagLibrarySearchAction).assert(hasText("Search"))
    compose.onNodeWithTag(remoteItemTag("f1")).assertExists()
  }

  @Test
  fun `a standalone series screen names the series once`() {
    val api = FakeTvApi().apply {
      remoteEpisodesPages["s1|"] = RemoteItemsPageDto(items = listOf(folder("e1", "Pilot")), total = 1)
    }
    scenario.onActivity { activity ->
      activity.setContent {
        RemoteSeriesScreen(
          api = api,
          data = RemoteDetailData(
            libraryId = "rlibA",
            libraryName = "Server",
            provider = "emby",
            item = RemoteItemDto(id = "s1", name = "Show", type = "series", providerIds = RemoteProviderIdsDto(imdb = "tt5")),
          ),
          imageUrl = { null },
          onPlay = {},
          onBack = {},
        )
      }
    }
    compose.waitForIdle()
    compose.waitUntil(5_000) { api.remoteEpisodesRequests.isNotEmpty() }
    compose.waitForIdle()

    compose.onNodeWithText("Show").assertExists()
    compose.onNodeWithTag(remoteItemTag("e1")).assertExists()
    // No section heading beside it: this screen is not the Library section's own page.
    compose.onNodeWithTag(TagLibraryHeaderTitle).assertDoesNotExist()
  }

  @Test
  fun `the library toolbar draws no mic`() {
    val api = api()
    mountEmbedded(api)
    openLibrary(api)

    compose.onNodeWithContentDescription("Voice search").assertDoesNotExist()
  }

  @Test
  fun `the field and the submit button share their bottom edge`() {
    val api = api()
    mountEmbedded(api)
    openLibrary(api)
    focusOn(TagLibrarySearchAction)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagLibrarySearchField).assertExists()

    val field = compose.onNodeWithTag(TagLibrarySearchField).fetchSemanticsNode().boundsInRoot
    val submit = compose.onNodeWithTag(TagLibrarySearchSubmit).fetchSemanticsNode().boundsInRoot
    val gap = kotlin.math.abs(field.bottom - submit.bottom)
    assertTrue("the field ends at ${field.bottom}px and the button at ${submit.bottom}px", gap <= 2f)
    // The field's own box is 38.dp high, so sharing its height is the 38.dp button the row wants.
    assertEquals(field.height, submit.height, 0.5f)
  }

  @Test
  fun `a remote search at the library root sends the library without a parent`() {
    val api = api()
    val opened = mutableListOf<LibrarySearchScope>()
    mountEmbedded(api, searchEverywhereEnabled = true, onOpenSearch = { scope -> opened += scope })
    openLibrary(api)

    compose.onNodeWithTag(TagLibrarySearchField).assertDoesNotExist()
    compose.onNodeWithContentDescription("Voice search").assertDoesNotExist()
    focusOn(TagLibrarySearchAction)
    press(Key.DirectionCenter)

    val scope = opened.single()
    assertEquals(GlobalSearchLibraryDto("rlibA"), scope.library)
    assertEquals(listOf("remote"), scope.sources)
    assertEquals("Server", scope.title)
  }

  @Test
  fun `a remote folder search sends the folder parent id`() {
    val api = api()
    val opened = mutableListOf<LibrarySearchScope>()
    mountEmbedded(api, searchEverywhereEnabled = true, onOpenSearch = { scope -> opened += scope })
    openLibrary(api)
    compose.onNodeWithTag(remoteItemTag("f1")).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()

    focusOn(TagLibrarySearchAction)
    press(Key.DirectionCenter)

    assertEquals(GlobalSearchLibraryDto("rlibA", parentId = "f1"), opened.single().library)
    assertEquals(listOf("remote"), opened.single().sources)
    assertEquals("Server  ›  Shows", opened.single().title)
  }

  @Test
  fun `the type button cycles all movies series and back`() {
    val api = api()
    mountEmbedded(api, searchEverywhereEnabled = true)
    openLibrary(api)
    val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    compose.onNodeWithTag(TagLibraryTypeFilter).assert(hasText(context.getString(R.string.tv_library_type_all)))
    compose.onNodeWithText("Movies").assertDoesNotExist()

    focusOn(TagLibraryTypeFilter)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.remoteBrowseRequests.any { it.type == "movie" } }
    compose.onNodeWithTag(TagLibraryTypeFilter).assert(hasText(context.getString(R.string.tv_library_type_movies)))

    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.remoteBrowseRequests.any { it.type == "series" } }
    compose.onNodeWithTag(TagLibraryTypeFilter).assert(hasText(context.getString(R.string.tv_library_type_series)))

    press(Key.DirectionCenter)
    compose.waitUntil(5_000) {
      api.remoteBrowseRequests.lastOrNull()?.type == null &&
        api.remoteBrowseRequests.count { it.type == null } >= 2
    }
    compose.onNodeWithTag(TagLibraryTypeFilter).assert(hasText(context.getString(R.string.tv_library_type_all)))
    focusOn(TagLibraryTypeFilter)
    press(Key.DirectionLeft)
    compose.onNodeWithTag(TagLibrarySearchAction).assertIsFocused()
  }
}
