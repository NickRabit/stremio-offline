@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.library

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.test.core.app.ApplicationProvider
import android.content.Intent
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.BrowseResult
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.GlobalSearchLibraryDto
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteItemsPageDto
import cz.stremiooffline.tv.data.RemoteLibraryDto
import cz.stremiooffline.tv.ui.components.TagPosterMosaic
import cz.stremiooffline.tv.ui.components.libraryRootCountTag
import cz.stremiooffline.tv.ui.BrowseRequest
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.DetailData
import cz.stremiooffline.tv.ui.search.LibrarySearchScope
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class LibraryScreenTest {

  @get:Rule val compose = createEmptyComposeRule()

  private var host: ComponentActivity? = null
  private lateinit var scenario: androidx.test.core.app.ActivityScenario<ComponentActivity>

  @org.junit.Before
  fun launchHost() {
    scenario = androidx.test.core.app.ActivityScenario.launch(
      Intent(ApplicationProvider.getApplicationContext(), ComponentActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
  }

  @org.junit.After
  fun closeHost() {
    scenario.close()
  }

  private fun folder(path: String, name: String, fileCount: Int = 1) =
    BrowseItem.Folder(path = path, name = name, fileCount = fileCount)

  private fun file(path: String) = BrowseItem.File(path = path, label = path.substringAfterLast('/'))

  private fun remoteFolder(id: String, name: String) = RemoteItemDto(id = id, name = name, type = "folder")

  private fun mount(
    api: FakeTvApi,
    pendingDelayMs: Long = 1_500L,
    onDetail: (DetailData) -> Unit = {},
    onOpenSearch: ((LibrarySearchScope) -> Unit)? = null,
    searchEverywhereEnabled: Boolean = false,
  ) {
    scenario.onActivity { activity ->
      host = activity
      activity.setContent {
      LibraryRoute(
        api = api,
        onOpenDetail = onDetail,
        onOpenSearch = onOpenSearch ?: {},
        searchEverywhereEnabled = searchEverywhereEnabled,
        pendingDelayMs = pendingDelayMs,
      )
      }
    }
  }

  private fun submitSearch(query: String) {
    focusOn(TagLibrarySearchAction)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagLibrarySearchInput).performTextInput(query)
    compose.onNodeWithTag(TagLibrarySearchInput).performImeAction()
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()
  }

  // Bug: the first walk of a library answered empty with pending; the screen must not fall into
  // the empty state, and the view model retry is covered by LibraryViewModelTest.
  @Test
  fun `a pending answer with no items shows loading, not the empty state`() {
    var call = 0
    val api = object : FakeTvApi() {
      override suspend fun browse(path: String?, limit: Int, skip: Int, query: String): BrowseResult {
        call++
        return BrowseResult(path.orEmpty(), emptyList(), 1, pending = true)
      }
    }
    mount(api, pendingDelayMs = 5L)

    assertEquals(1, call)
    compose.onNodeWithTag("Films").assertDoesNotExist()
  }

  @Test
  fun `the root page shows the fake's folders`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult("", listOf(folder("Films", "Films"), folder("Shows", "Shows")), 2, false)
    mount(api)
    switchTo("Files")

    compose.onNodeWithTag("Films").assertIsFocused()
    compose.onNodeWithTag("Shows").assertExists()
  }

  @Test
  fun `ok on a folder whose browse is only files opens the detail`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult("", listOf(folder("Films/It", "It")), 1, false)
    api.pages["Films/It"] = BrowseResult("Films/It", listOf(file("Films/It/It.mkv")), 1, false)
    val details = mutableListOf<DetailData>()
    mount(api, onDetail = { details += it })
    switchTo("Files")

    compose.waitForIdle()
    compose.onNodeWithTag("Films/It").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    assertEquals(1, details.size)
    assertEquals("It", details[0].title)
  }

  @Test
  fun `ok on a folder with subfolders opens a nested grid and back restores focus`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult("", listOf(folder("Shows", "Shows")), 1, false)
    api.pages["Shows"] = BrowseResult("Shows", listOf(folder("Shows/S1", "S1"), folder("Shows/S2", "S2")), 2, false)
    mount(api)
    switchTo("Files")

    compose.onNodeWithTag("Shows").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()
    compose.onNodeWithTag("Shows/S2").assertExists()

    // The nested grid's first card takes focus.
    compose.onNodeWithTag("Shows/S1").assertIsFocused()
    // Moving right shows the whole row, then Back returns to the parent with the card focused.
    compose.onNodeWithTag("Shows/S1").performKeyInput { pressKey(Key.DirectionRight) }
    compose.onNodeWithTag("Shows/S2").assertIsFocused()

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()
    compose.onNodeWithTag("Shows/S2").assertDoesNotExist()
    compose.onNodeWithTag("Shows").assertIsFocused()
  }

  // Bug 5: `openedBy` recorded a folder that opened the detail too, so the next Back restored
  // focus to the wrong card.
  @Test
  fun `a folder that opened and closed a detail does not shift the next back's focus`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult(
      "",
      listOf(folder("It", "It"), folder("S1", "S1")),
      2,
      false,
    )
    api.pages["It"] = BrowseResult("It", listOf(file("It/It.mkv")), 1, false)
    api.pages["S1"] = BrowseResult("S1", listOf(folder("S1/E1", "E1")), 1, false)
    val details = mutableListOf<DetailData>()
    mount(api, onDetail = { details += it })
    switchTo("Files")
    compose.waitForIdle()

    // Open the only-files folder: it opens the detail and must not be booked as a pushed level.
    compose.onNodeWithTag("It").assertIsFocused()
    compose.onNodeWithTag("It").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    assertEquals(1, details.size)

    // The grid kept the folder focused; RIGHT reaches the nested folder. Push it and go Back: its
    // own card must take focus, not the folder that opened the detail earlier.
    compose.onNodeWithTag("It").performKeyInput { pressKey(Key.DirectionRight) }
    compose.waitForIdle()
    compose.onNodeWithTag("S1").assertIsFocused()
    compose.onNodeWithTag("S1").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.onNodeWithTag("S1/E1").assertExists()

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()
    compose.onNodeWithTag("S1").assertIsFocused()
    compose.onNodeWithTag("S1/E1").assertDoesNotExist()
  }

  // The Favourites card is gone: the library root asks for its own listing only.
  @Test
  fun `the library root no longer asks for favourites`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult("", listOf(folder("Films", "Films")), 1, false)
    mount(api)
    switchTo("Files")
    compose.waitForIdle()

    compose.onNodeWithTag("Films").assertIsFocused()
    assertTrue(api.favoritesRequests.isEmpty())
  }

  // --- The shared compact chrome of the section -------------------------------------------------

  private fun focusedTag(): String = compose.onAllNodes(isFocused()).fetchSemanticsNodes()
    .firstOrNull()?.config?.getOrElse(SemanticsProperties.TestTag) { "" } ?: ""

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()
  }

  private fun focusOn(tag: String) {
    compose.onNodeWithTag(tag).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
  }

  /** The Files/Media servers switch: the segment is a D-pad surface, so it is focused and OK'd. */
  private fun switchTo(text: String) {
    compose.onNodeWithText(text).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()
  }

  /** The whole library the section opens two levels of: a folder that holds a folder and a film. */
  private fun nested(): FakeTvApi = FakeTvApi().apply {
    pages[null] = BrowseResult("", listOf(folder("Shows", "Shows")), 1, false)
    pages["Shows"] = BrowseResult("Shows", listOf(folder("Shows/S1", "S1")), 1, false)
    // A level of its own, so opening it pushes a page rather than opening a title's detail.
    pages["Shows/S1"] = BrowseResult("Shows/S1", listOf(folder("Shows/S1/E1", "E1")), 1, false)
  }

  @Test
  fun `one heading stands beside the switch with no eyebrow above it`() {
    mount(nested())
    compose.waitForIdle()

    // One heading, on the same row as the two halves' switch.
    val heading = compose.onNodeWithTag(TagLibraryHeaderTitle).fetchSemanticsNode().boundsInRoot
    val files = compose.onNodeWithText("Files").fetchSemanticsNode().boundsInRoot
    assertTrue("the switch sits on the heading's own row", files.top < heading.bottom && heading.top < files.bottom)
    assertTrue("the header stays one compact row", heading.bottom < 90f * 2f)
    compose.onNodeWithText("LIBRARY").assertDoesNotExist()
  }

  @Test
  fun `the first grid card starts high on the page while the editor is closed`() {
    mount(nested())
    switchTo("Files")
    compose.waitForIdle()

    // The qualifier fixes the density at 2, so 180dp is 360px: no editor, no second heading and no
    // nested padding may push the first card past roughly 180dp of a 540dp screen.
    val top = compose.onNodeWithTag("Shows").fetchSemanticsNode().boundsInRoot.top
    assertTrue("the first card starts at $top px, not below 180dp", top < 180f * 2f)
  }

  @Test
  fun `the files breadcrumb is absent while the servers half is showing`() {
    val api = nested()
    api.remoteLibrariesValue = listOf(RemoteLibraryDto(id = "rlibA", name = "Server", provider = "emby"))
    mount(api)
    switchTo("Files")
    compose.waitForIdle()

    compose.onNodeWithTag("Shows").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()
    compose.onNodeWithTag(TagLibraryBreadcrumb).assertExists()

    switchTo("Media servers")
    compose.waitUntil(5_000) { api.remoteLibrariesCalls > 0 }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()

    // The servers half owns the page: the filesystem's path is gone, the section keeps its one
    // heading instead of a second large one, and the servers' own path appears once a library is open.
    compose.onNodeWithTag(TagLibraryBreadcrumb).assertDoesNotExist()
    compose.onNodeWithTag(TagRemoteBreadcrumb).assertDoesNotExist()
    compose.onNodeWithText("Choose a library").assertDoesNotExist()
    compose.onNodeWithTag(TagLibraryHeaderTitle).assertExists()
    compose.onNodeWithTag(remoteLibraryTag("rlibA")).assertIsFocused()

    compose.onNodeWithTag(remoteLibraryTag("rlibA")).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()
    compose.onNodeWithTag(TagRemoteBreadcrumb).assertExists()
  }

  @Test
  fun `the search editor is closed until the action opens it and submitting narrows the level`() {
    val api = nested()
    api.browseQueries["Shows|S1"] = BrowseResult("Shows", listOf(folder("Shows/S1", "S1")), 1, false)
    mount(api)
    switchTo("Files")
    compose.waitForIdle()
    compose.onNodeWithTag("Shows").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()

    compose.onNodeWithTag(TagLibrarySearchField).assertDoesNotExist()
    compose.onNodeWithTag(TagLibrarySearchSubmit).assertDoesNotExist()

    focusOn(TagLibrarySearchAction)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagLibrarySearchField).assertIsFocused()
    compose.onNodeWithTag(TagLibrarySearchSubmit).assertExists()

    // The field is the app's own: the query travels only on the IME action, never per keystroke.
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagLibrarySearchInput).performTextInput("S1")
    compose.waitForIdle()
    assertTrue("nothing is asked before the query is submitted", api.browseRequests.none { it.query == "S1" })
    compose.onNodeWithTag(TagLibrarySearchInput).performImeAction()
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()

    assertEquals("S1", api.browseRequests.last().query)
    assertEquals("Shows", api.browseRequests.last().path)
    // One request for the narrowed level: no page is walked ahead, and the editor is gone again.
    assertEquals(1, api.browseRequests.count { it.query == "S1" })
    compose.onNodeWithTag(TagLibrarySearchField).assertDoesNotExist()
    compose.onNodeWithTag(TagLibrarySearchAction).assertExists()
  }

  @Test
  fun `back closes the open editor before the level is left`() {
    mount(nested())
    switchTo("Files")
    compose.waitForIdle()
    compose.onNodeWithTag("Shows").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()
    compose.onNodeWithTag(TagLibraryBreadcrumb).assertExists()

    focusOn(TagLibrarySearchAction)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagLibrarySearchField).assertExists()

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()

    // The editor is gone, the level is not: the path and the action are both still there.
    compose.onNodeWithTag(TagLibrarySearchField).assertDoesNotExist()
    compose.onNodeWithTag(TagLibraryBreadcrumb).assertExists()
    compose.onNodeWithTag(TagLibrarySearchAction).assertIsFocused()
  }

  @Test
  fun `a title opened under a search leaves the parent's own search in place`() {
    val api = nested()
    api.browseQueries["Shows|S1"] = BrowseResult("Shows", listOf(folder("Shows/S1", "S1")), 1, false)
    mount(api)
    switchTo("Files")
    compose.waitForIdle()
    compose.onNodeWithTag("Shows").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()

    focusOn(TagLibrarySearchAction)
    press(Key.DirectionCenter)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagLibrarySearchInput).performTextInput("S1")
    compose.onNodeWithTag(TagLibrarySearchInput).performImeAction()
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()

    compose.onNodeWithTag("Shows/S1").assertExists()

    // A level opened from the narrowed list is the whole level, never the parent's matching rows.
    focusOn("Shows/S1")
    press(Key.DirectionCenter)
    assertEquals("Shows/S1", api.browseRequests.last().path)
    assertEquals("", api.browseRequests.last().query)

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()

    // Back lands on the parent's own narrowed list, still narrowed and without a second read of it.
    compose.onNodeWithTag("Shows/S1").assertExists()
    assertEquals(1, api.browseRequests.count { it.query == "S1" })
  }

  @Test
  fun `a late files answer never steals the remote from the servers half`() {
    val gate = CompletableDeferred<Unit>()
    var holdNext = false
    val api = object : FakeTvApi() {
      override suspend fun browse(path: String?, limit: Int, skip: Int, query: String): BrowseResult {
        browseCalls += path to skip
        browseRequests += BrowseRequest(path, limit, skip, query)
        if (holdNext && path == null) {
          gate.await()
          // The refreshed root answers with one more folder than it had before.
          return BrowseResult("", listOf(folder("Films", "Films"), folder("Shows", "Shows")), 2, false)
        }
        return super.browse(path, limit, skip, query)
      }
    }
    api.pages[null] = BrowseResult("", listOf(folder("Shows", "Shows")), 1, false)
    api.remoteLibrariesValue = listOf(RemoteLibraryDto(id = "rlibA", name = "Server", provider = "emby"))
    api.remoteBrowsePages["rlibA||"] = RemoteItemsPageDto(items = listOf(remoteFolder("f1", "Films")), total = 1)
    val refresh = mutableStateOf(0)
    scenario.onActivity { activity ->
      activity.setContent {
        LibraryRoute(api = api, onOpenDetail = {}, refreshToken = refresh.value)
      }
    }
    compose.waitForIdle()
    switchTo("Files")
    compose.onNodeWithTag("Shows").assertIsFocused()

    switchTo("Media servers")
    compose.waitUntil(5_000) { api.remoteLibrariesCalls > 0 }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()
    compose.onNodeWithTag(remoteLibraryTag("rlibA")).assertIsFocused()

    // The half the viewer left answers late: the remote stays in the half they are looking at.
    holdNext = true
    compose.runOnIdle { refresh.value = 1 }
    compose.waitForIdle()
    gate.complete(Unit)
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()

    compose.onNodeWithTag(remoteLibraryTag("rlibA")).assertIsFocused()
    compose.onNodeWithTag("Films").assertDoesNotExist()
  }

  @Test
  fun `a query that matches nothing stays reachable and can be cleared again`() {
    val api = nested()
    api.browseQueries["Shows|zz"] = BrowseResult("Shows", emptyList(), 0, false)
    mount(api)
    switchTo("Files")
    compose.waitForIdle()
    compose.onNodeWithTag("Shows").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()

    focusOn(TagLibrarySearchAction)
    press(Key.DirectionCenter)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagLibrarySearchInput).performTextInput("zz")
    compose.onNodeWithTag(TagLibrarySearchInput).performImeAction()
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()

    // Nothing matched, and the action that opens the query is still there.
    compose.onNodeWithTag("Shows/S1").assertDoesNotExist()
    compose.onNodeWithTag(TagLibrarySearchAction).assert(hasText("Search"))
    // The empty level reads as "nothing matched", not as an empty library.
    compose.onNodeWithText(
      androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        .getString(cz.stremiooffline.tv.R.string.media_server_no_matches),
    ).assertExists()

    // Reopening pre-fills it, and clearing it brings the whole level back.
    focusOn(TagLibrarySearchAction)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagLibrarySearchInput).assertTextContains("zz")
    compose.onNodeWithTag(TagLibrarySearchInput).performTextClearance()
    compose.onNodeWithTag(TagLibrarySearchInput).performImeAction()
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()

    compose.onNodeWithTag("Shows/S1").assertExists()
    compose.onNodeWithTag(TagLibrarySearchAction).assert(hasText("Search"))
  }

  @Test
  fun `a return from a detail keeps the row the viewer had already scrolled to`() {
    val all = (1..72).map { folder("Shows/F$it", "F$it") }
    val api = object : FakeTvApi() {
      override suspend fun browse(path: String?, limit: Int, skip: Int, query: String): BrowseResult {
        browseCalls += path to skip
        browseRequests += BrowseRequest(path, limit, skip, query)
        return BrowseResult("Shows", all.drop(skip).take(limit), all.size, false)
      }
    }
    val refresh = mutableStateOf(0)
    scenario.onActivity { activity ->
      activity.setContent { LibraryRoute(api = api, onOpenDetail = {}, refreshToken = refresh.value) }
    }
    compose.waitForIdle()
    switchTo("Files")
    compose.onNodeWithTag("Shows/F1").assertIsFocused()

    // Walking down to the end of the first page asks for the next one, and the remote lands on a
    // row the first page does not hold.
    repeat(11) { press(Key.DirectionDown) }
    val selected = focusedTag()
    val number = selected.removePrefix("Shows/F").toIntOrNull()
    assertTrue("a row beyond the first page is focused, not $selected", number != null && number > 60)

    // A detail return re-reads the first page; that row is still there and still focused.
    val reads = api.browseRequests.size
    compose.runOnIdle { refresh.value = 1 }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()

    compose.onNodeWithTag(selected).assertExists()
    compose.onNodeWithTag(selected).assertIsFocused()
    // Only the first page was re-read: the tail came from the level itself, not another walk.
    assertEquals(reads + 1, api.browseRequests.size)
    assertEquals(0, api.browseRequests.last().skip)
  }

  // --- The All grid and the search row ----------------------------------------------------------

  private fun localLibrary(path: String, name: String = path) = BrowseItem.Library(path = path, name = name)

  @Test
  fun `a library root keeps its artwork left and its title once to the right`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult(
      "",
      listOf(BrowseItem.Library(path = "Films", name = "Films", fileCount = 12, poster = "/films.jpg")),
      1,
      false,
    )
    mount(api)
    switchTo("Files")
    compose.waitForIdle()

    val card = compose.onNodeWithTag("Films").getBoundsInRoot()
    val title = compose.onNodeWithText("Films", useUnmergedTree = true).getBoundsInRoot()
    val count = compose.onNodeWithTag(libraryRootCountTag("Films"), useUnmergedTree = true)
    compose.onNodeWithText("12", useUnmergedTree = true).assertExists()
    assertTrue("title must be beside the artwork", title.left > count.getBoundsInRoot().right)
    assertTrue("title stays inside the card", title.bottom < card.bottom)
    assertTrue("library roots use a landscape card", (card.right - card.left) > (card.bottom - card.top) * 2)
    assertEquals(1, compose.onAllNodesWithText("Films", useUnmergedTree = true).fetchSemanticsNodes().size)
  }

  @Test
  fun `a nonempty pending library root stays usable while artwork refreshes`() {
    val api = object : FakeTvApi() {
      override suspend fun browse(path: String?, limit: Int, skip: Int, query: String): BrowseResult {
        if (path == null) {
          return BrowseResult(
            "",
            listOf(BrowseItem.Library(path = "Films", name = "Films", mosaicImage = null)),
            1,
            pending = true,
          )
        }
        return BrowseResult(path, listOf(file("Films/It/It.mkv")), 1, false)
      }
    }
    var opened: DetailData? = null
    mount(api, pendingDelayMs = 10_000L, onDetail = { opened = it })
    compose.waitForIdle()
    switchTo("Files")

    focusOn("Films")
    compose.onNodeWithTag("Films").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitUntil(5_000) {
      compose.onAllNodesWithTag("Films/It/It.mkv").fetchSemanticsNodes().isNotEmpty()
    }
    focusOn("Films/It/It.mkv")
    compose.onNodeWithTag("Films/It/It.mkv").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitUntil(5_000) { opened != null }

    assertEquals("Films/It/It.mkv", opened?.files?.single()?.path)
  }

  @Test
  fun `the section opens on the All grid with the local and the remote library`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult("", listOf(localLibrary("Films")), 1, false)
    api.remoteLibrariesValue = listOf(RemoteLibraryDto(id = "rlibA", name = "Server", provider = "emby"))
    mount(api)
    compose.waitUntil(5_000) { api.remoteLibrariesCalls > 0 }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()

    compose.onNodeWithTag("all_local:Films").assertExists()
    compose.onNodeWithTag("all_remote:rlibA").assertExists()
  }

  @Test
  fun `a local library opened from All lands in Files and Back returns to All focused`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult("", listOf(localLibrary("Films")), 1, false)
    api.pages["Films"] = BrowseResult("Films", listOf(folder("Films/It", "It")), 1, false)
    mount(api)
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()

    focusOn("all_local:Films")
    compose.onNodeWithTag("all_local:Films").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()

    compose.onNodeWithTag(TagLibraryBreadcrumb).assertExists()
    compose.onNodeWithTag("Films/It").assertExists()

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()

    compose.onNodeWithTag("all_local:Films").assertIsFocused()
    compose.onNodeWithTag("Films/It").assertDoesNotExist()
  }

  @Test
  fun `Back to a scrolled All grid restores the remote library tile`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult("", listOf(localLibrary("Films")), 1, false)
    api.remoteLibrariesValue = (0..10).map { RemoteLibraryDto(id = "r$it", name = "Server $it", provider = "emby", type = "mixed") }
    api.remoteBrowsePages["r8||"] = RemoteItemsPageDto(items = listOf(remoteFolder("f1", "Shows")), total = 1)
    mount(api)
    compose.waitUntil(5_000) { api.remoteLibrariesCalls > 0 }
    compose.waitForIdle()
    compose.onNodeWithTag(TagLibraryAllGrid).performScrollToNode(hasTestTag("all_remote:r8"))
    focusOn("all_remote:r8")
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.remoteBrowseRequests.isNotEmpty() }
    compose.waitForIdle()
    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()
    compose.onNodeWithTag("all_remote:r8").assertIsFocused()
  }

  @Test
  fun `a media-server library opened from All lands in Servers and Back returns to All focused`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult("", listOf(localLibrary("Films")), 1, false)
    api.remoteLibrariesValue = listOf(RemoteLibraryDto(id = "rlibA", name = "Server", provider = "emby", type = "mixed"))
    api.remoteBrowsePages["rlibA||"] = RemoteItemsPageDto(items = listOf(remoteFolder("f1", "Shows")), total = 1)
    mount(api)
    compose.waitUntil(5_000) { api.remoteLibrariesCalls > 0 }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()

    focusOn("all_remote:rlibA")
    compose.onNodeWithTag("all_remote:rlibA").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitUntil(5_000) { api.remoteBrowseRequests.isNotEmpty() }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()
    compose.onNodeWithTag(TagRemoteBreadcrumb).assertExists()

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()

    // Back lands on the All grid rather than on the media-server picker, on the tile that was opened.
    compose.onNodeWithTag("all_remote:rlibA").assertIsFocused()
    compose.onNodeWithTag(remoteLibraryTag("rlibA")).assertDoesNotExist()
  }

  @Test
  fun `Files chosen on the switch keeps Back at its root away from All`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult("", listOf(localLibrary("Films")), 1, false)
    mount(api)
    switchTo("Files")
    compose.waitForIdle()

    compose.onNodeWithTag("all_local:Films").assertDoesNotExist()
    compose.onNodeWithTag("Films").assertExists()

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()

    compose.onNodeWithTag("all_local:Films").assertDoesNotExist()
    compose.onNodeWithTag("Films").assertExists()
  }

  @Test
  fun `OK on the search action opens the page rooted at the level on screen`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult("", listOf(localLibrary("lib_ab12cd34", "Films")), 1, false)
    api.pages["lib_ab12cd34"] = BrowseResult(
      "lib_ab12cd34",
      listOf(folder("lib_ab12cd34/Shows", "Shows")),
      1,
      false,
    )
    api.pages["lib_ab12cd34/Shows"] = BrowseResult(
      "lib_ab12cd34/Shows",
      listOf(folder("lib_ab12cd34/Shows/S1", "S1")),
      1,
      false,
    )
    val opened = mutableListOf<LibrarySearchScope>()
    mount(api, searchEverywhereEnabled = true, onOpenSearch = { scope -> opened += scope })
    switchTo("Files")
    compose.onNodeWithTag("lib_ab12cd34").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()
    compose.onNodeWithTag("lib_ab12cd34/Shows").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()

    compose.onNodeWithTag(TagLibrarySearchField).assertDoesNotExist()
    compose.onNodeWithContentDescription("Voice search").assertDoesNotExist()
    compose.onNodeWithTag(TagLibrarySearchAction).assert(hasText("Search"))
    focusOn(TagLibrarySearchAction)
    press(Key.DirectionCenter)

    val scope = opened.single()
    assertEquals(GlobalSearchLibraryDto("lib_ab12cd34", path = "Shows"), scope.library)
    assertEquals(listOf("local"), scope.sources)
    assertEquals("Films  ›  Shows", scope.title)
  }

  @Test
  fun `the files root opens the page without a library`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult(
      "",
      listOf(localLibrary("lib_1", "Films"), localLibrary("lib_2", "Shows")),
      2,
      false,
    )
    val opened = mutableListOf<LibrarySearchScope>()
    mount(api, searchEverywhereEnabled = true, onOpenSearch = { scope -> opened += scope })
    switchTo("Files")

    focusOn(TagLibrarySearchAction)
    press(Key.DirectionCenter)

    assertEquals(null, opened.single().library)
    assertEquals(listOf("local"), opened.single().sources)
    assertEquals("Your library", opened.single().title)
  }

  @Test
  fun `UP from the first tile reaches Search`() {
    mount(nested(), searchEverywhereEnabled = true)
    switchTo("Files")

    compose.onNodeWithTag("Shows").assertIsFocused()
    press(Key.DirectionUp)
    compose.onNodeWithTag(TagLibrarySearchAction).assertIsFocused()
  }

  @Test
  fun `the All tab offers Search when the flag is on and hides it when the flag is off`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult("", listOf(localLibrary("Films")), 1, false)
    mount(api, searchEverywhereEnabled = false)
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()

    compose.onNodeWithTag(TagLibraryAllGrid).assertExists()
    compose.onNodeWithTag(TagLibrarySearchAction).assertDoesNotExist()

    val opened = mutableListOf<LibrarySearchScope>()
    mount(api, searchEverywhereEnabled = true, onOpenSearch = { scope -> opened += scope })
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()

    compose.onNodeWithTag(TagLibrarySearchAction).assertExists()
    focusOn(TagLibrarySearchAction)
    press(Key.DirectionCenter)
    assertEquals(null, opened.single().library)
    assertEquals(listOf("local", "remote"), opened.single().sources)

    focusOn("all_local:Films")
    press(Key.DirectionUp)
    compose.onNodeWithTag(TagLibrarySearchAction).assertIsFocused()
  }

  @Test
  fun `a files search with the flag off keeps the browse query`() {
    val api = nested()
    api.globalSearchEnabled = false
    api.browseQueries["Shows|S1"] = BrowseResult("Shows", listOf(folder("Shows/S1", "S1")), 1, false)
    mount(api, searchEverywhereEnabled = false)
    switchTo("Files")
    compose.onNodeWithTag("Shows").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()

    submitSearch("S1")

    assertTrue(api.globalStartCalls.isEmpty())
    assertEquals("S1", api.browseRequests.last().query)
  }
}
