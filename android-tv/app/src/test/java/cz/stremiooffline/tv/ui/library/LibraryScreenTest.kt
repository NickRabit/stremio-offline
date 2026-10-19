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
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onAllNodesWithTag
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
import cz.stremiooffline.tv.data.GlobalSearchClusterDto
import cz.stremiooffline.tv.data.GlobalSearchLibraryDto
import cz.stremiooffline.tv.data.GlobalSearchLocatorDto
import cz.stremiooffline.tv.data.GlobalSearchMemberDto
import cz.stremiooffline.tv.data.GlobalSearchMemberPageDto
import cz.stremiooffline.tv.data.GlobalSearchSnapshotDto
import cz.stremiooffline.tv.data.GlobalSearchStartResultDto
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteItemsPageDto
import cz.stremiooffline.tv.data.RemoteLibraryDto
import cz.stremiooffline.tv.ui.catalog.VoiceLauncher
import cz.stremiooffline.tv.ui.components.TagPosterMosaic
import cz.stremiooffline.tv.ui.BrowseRequest
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.DetailData
import cz.stremiooffline.tv.ui.search.globalSearchCardTag
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
    onOpenLibrary: ((String) -> Unit)? = null,
    searchEverywhereEnabled: Boolean = false,
    voiceAvailable: Boolean? = null,
    voiceLauncher: VoiceLauncher? = null,
  ) {
    scenario.onActivity { activity ->
      host = activity
      activity.setContent {
      LibraryRoute(
        api = api,
        onOpenDetail = onDetail,
        onOpenLibrary = onOpenLibrary,
        searchEverywhereEnabled = searchEverywhereEnabled,
        pendingDelayMs = pendingDelayMs,
        voiceAvailable = voiceAvailable,
        voiceLauncher = voiceLauncher,
      )
      }
    }
  }

  private fun searchResult(api: FakeTvApi, member: GlobalSearchMemberDto) {
    api.globalStartHandler = {
      GlobalSearchStartResultDto(
        id = "gs",
        snapshot = GlobalSearchSnapshotDto(
          revision = 1,
          state = "complete",
          clusters = listOf(
            GlobalSearchClusterDto(
              key = "one",
              kind = member.kind,
              title = member.title,
              memberCount = 1,
              primaryMemberKey = member.memberKey,
              memberKeys = listOf(member.memberKey),
            ),
          ),
        ),
      )
    }
    api.globalMembersHandler = { _, _, _ ->
      GlobalSearchMemberPageDto(clusterKey = "one", members = listOf(member))
    }
  }

  private fun localMember(path: String, kind: String = "file") = GlobalSearchMemberDto(
    memberKey = "m1",
    sourceId = "local",
    sourceClass = "local",
    sourceLabel = "Films",
    kind = "movie",
    title = "Hluboky soubor",
    locator = GlobalSearchLocatorDto(kind = "local", key = path, libraryId = "lib_ab12cd34", itemKind = kind),
  )

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
    compose.onNodeWithTag(TagLibrarySearchAction).assert(hasText("S1"))

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
    compose.onNodeWithTag(TagLibrarySearchAction).assert(hasText("S1"))
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

    // Nothing matched, and the action that owns the query is still there with it.
    compose.onNodeWithTag("Shows/S1").assertDoesNotExist()
    compose.onNodeWithTag(TagLibrarySearchAction).assert(hasText("zz"))
    // The empty level reads as "nothing matched", not as an empty library.
    compose.onNodeWithText(
      androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        .getString(cz.stremiooffline.tv.R.string.media_server_no_matches),
    ).assertExists()

    // Reopening pre-fills it, and clearing it brings the whole level back.
    focusOn(TagLibrarySearchAction)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagLibrarySearchInput).performTextClearance()
    compose.onNodeWithTag(TagLibrarySearchInput).performImeAction()
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()

    compose.onNodeWithTag("Shows/S1").assertExists()
    compose.onNodeWithTag(TagLibrarySearchAction).assert(hasText(
      androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        .getString(cz.stremiooffline.tv.R.string.media_server_search_action),
    ))
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

  /** The microphone seam: each press is recorded and answered when the test says so. */
  private class Voice {
    val calls = mutableListOf<(String) -> Unit>()

    fun answer(spoken: String) {
      calls.last()(spoken)
    }
  }

  private fun localLibrary(path: String, name: String = path) = BrowseItem.Library(path = path, name = name)

  @Test
  fun `a library that carries a composed mosaic draws it instead of the collage`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult(
      "",
      listOf(
        BrowseItem.Library(path = "A", name = "A", mosaicImage = "/api/library/mosaic?dir=A&shape=wide"),
        BrowseItem.Library(path = "B", name = "B", posters = listOf("/p1.jpg", "/p2.jpg")),
      ),
      2,
      false,
    )
    mount(api)
    switchTo("Files")
    compose.waitForIdle()

    // The composed mosaic replaces the collage; only the library without one keeps today's drawing.
    assertEquals(1, compose.onAllNodesWithTag(TagPosterMosaic, useUnmergedTree = true).fetchSemanticsNodes().size)
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
  fun `the mic on a files level submits what it heard`() {
    val voice = Voice()
    val api = nested()
    api.browseQueries["Shows|matrix"] = BrowseResult("Shows", emptyList(), 0, false)
    mount(api, voiceAvailable = true, voiceLauncher = { onResult -> voice.calls += onResult })
    switchTo("Files")
    compose.waitForIdle()
    compose.onNodeWithTag("Shows").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()

    focusOn(TagLibrarySearchAction)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagLibrarySearchVoice).assertExists()
    focusOn(TagLibrarySearchVoice)
    press(Key.DirectionCenter)
    assertEquals(1, voice.calls.size)
    voice.answer("matrix")
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()

    assertEquals("matrix", api.browseRequests.last().query)
    compose.onNodeWithTag(TagLibrarySearchField).assertDoesNotExist()
    compose.onNodeWithTag(TagLibrarySearchAction).assert(hasText("matrix"))
  }

  @Test
  fun `a scoped files search sends the folder path and opens a local member`() {
    val api = FakeTvApi()
    api.globalSearchEnabled = true
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
    searchResult(api, localMember("lib_ab12cd34/Shows/S1/E1.mkv"))
    var opened: String? = null
    mount(api, searchEverywhereEnabled = true, onOpenLibrary = { opened = it })
    switchTo("Files")
    compose.onNodeWithTag("lib_ab12cd34").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()
    compose.onNodeWithTag("lib_ab12cd34/Shows").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()

    submitSearch("hluboky")

    assertEquals(
      GlobalSearchLibraryDto("lib_ab12cd34", path = "Shows"),
      api.globalStartCalls.single().library,
    )
    assertTrue(api.browseRequests.none { it.query == "hluboky" })
    compose.onNodeWithTag(globalSearchCardTag("m1")).assertExists()

    focusOn(TagLibrarySearchAction)
    press(Key.DirectionCenter)
    press(Key.DirectionDown)
    compose.onNodeWithTag(globalSearchCardTag("m1")).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitForIdle()
    assertEquals("lib_ab12cd34/Shows/S1/E1.mkv", opened)

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()
    compose.onNodeWithTag(globalSearchCardTag("m1")).assertDoesNotExist()
    compose.onNodeWithTag("lib_ab12cd34/Shows/S1").assertExists()
    compose.onNodeWithTag(TagLibrarySearchAction).assert(hasText(
      ApplicationProvider.getApplicationContext<android.content.Context>()
        .getString(R.string.media_server_search_action),
    ))
  }

  @Test
  fun `a files search at the multi-library root carries no library`() {
    val api = FakeTvApi()
    api.globalSearchEnabled = true
    api.pages[null] = BrowseResult(
      "",
      listOf(localLibrary("lib_1", "Films"), localLibrary("lib_2", "Shows")),
      2,
      false,
    )
    searchResult(api, localMember("lib_1/Film.mkv"))
    mount(api, searchEverywhereEnabled = true)
    switchTo("Files")

    submitSearch("hluboky")

    val body = api.globalStartCalls.single()
    assertEquals(null, body.library)
    assertEquals(listOf("local"), body.sources)
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
