@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.search

import androidx.activity.ComponentActivity
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
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
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.pressKey
import androidx.lifecycle.ViewModelProvider
import cz.stremiooffline.tv.data.GlobalSearchAliasDto
import cz.stremiooffline.tv.data.GlobalSearchCanonicalDto
import cz.stremiooffline.tv.data.GlobalSearchClusterDto
import cz.stremiooffline.tv.data.GlobalSearchLocatorDto
import cz.stremiooffline.tv.data.GlobalSearchMemberDto
import cz.stremiooffline.tv.data.GlobalSearchMemberPageDto
import cz.stremiooffline.tv.data.GlobalSearchLibraryDto
import cz.stremiooffline.tv.data.GlobalSearchPollDto
import cz.stremiooffline.tv.data.GlobalSearchSnapshotDto
import cz.stremiooffline.tv.data.GlobalSearchSourceDto
import cz.stremiooffline.tv.data.GlobalSearchStartResultDto
import cz.stremiooffline.tv.data.RecentSearchDto
import cz.stremiooffline.tv.data.RemoteItemDetailDto
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.SearchScope
import cz.stremiooffline.tv.data.SearchStateDto
import cz.stremiooffline.tv.data.SearchableCatalogDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.TagSearchRecentList
import cz.stremiooffline.tv.ui.catalog.TagSearchScopeAll
import cz.stremiooffline.tv.ui.catalog.TagSearchScopePanel
import cz.stremiooffline.tv.ui.catalog.VoiceLauncher
import cz.stremiooffline.tv.ui.catalog.recentRemoveTag
import cz.stremiooffline.tv.ui.catalog.recentSearchTag
import cz.stremiooffline.tv.ui.catalog.scopeAddonTag
import cz.stremiooffline.tv.ui.detail.RemoteDetailData
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class GlobalSearchScreenTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private var catalogOpened: cz.stremiooffline.tv.ui.catalog.CatalogDetailArgs? = null
  private var remoteOpened: RemoteDetailData? = null
  private var libraryOpened: String? = null

  private class Voice {
    val calls = mutableListOf<(String) -> Unit>()
    fun answer(text: String) = calls.last()(text)
  }

  private fun cluster(key: String, vararg members: String, title: String = key) = GlobalSearchClusterDto(
    key = key,
    kind = "movie",
    title = title,
    memberCount = members.size,
    primaryMemberKey = members.first(),
    memberKeys = members.toList(),
  )

  private fun source(
    id: String = "src",
    state: String = "exhausted",
    retryable: Boolean = false,
    hasMore: Boolean = false,
  ) = GlobalSearchSourceDto(
    id = id,
    sourceClass = "catalog",
    label = "Catalog $id",
    state = state,
    retryable = retryable,
    hasMore = hasMore,
  )

  private fun snapshot(
    revision: Int,
    cards: List<GlobalSearchClusterDto>,
    state: String = "complete",
    aliases: List<GlobalSearchAliasDto> = emptyList(),
    unidentified: List<GlobalSearchClusterDto> = emptyList(),
    sources: List<GlobalSearchSourceDto> = listOf(source()),
  ) = GlobalSearchSnapshotDto(
    revision = revision,
    state = state,
    sources = sources,
    clusters = cards,
    unidentified = unidentified,
    aliases = aliases,
  )

  private fun mount(
    api: FakeTvApi,
    voiceAvailable: Boolean = false,
    voiceLauncher: VoiceLauncher? = null,
    libraryScope: LibrarySearchScope? = null,
    onBack: (() -> Unit)? = null,
  ) {
    compose.setContent {
      GlobalSearchScreen(
        api = api,
        onOpenCatalog = { catalogOpened = it },
        onOpenRemote = { remoteOpened = it },
        onOpenLibrary = { libraryOpened = it },
        imageUrl = { null },
        overlayOpen = false,
        libraryScope = libraryScope,
        onBack = onBack,
        voiceAvailable = voiceAvailable,
        voiceLauncher = voiceLauncher,
      )
    }
    compose.waitForIdle()
  }

  private fun start(api: FakeTvApi, cards: List<GlobalSearchClusterDto>, state: String = "complete") {
    api.globalStartHandler = {
      GlobalSearchStartResultDto(id = "gs", snapshot = snapshot(1, cards, state))
    }
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun focused(tag: String): Boolean =
    compose.onAllNodes(isFocused()).fetchSemanticsNodes()
      .any { it.config.getOrElse(SemanticsProperties.TestTag) { "" } == tag }

  private fun focus(tag: String) {
    compose.onNodeWithTag(tag).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
  }

  private fun search(query: String = "matrix") {
    focus(TagGlobalSearchField)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagGlobalSearchInput).performTextInput(query)
    compose.onNodeWithTag(TagGlobalSearchInput).performImeAction()
    compose.waitForIdle()
  }

  private fun recent(vararg queries: String): List<RecentSearchDto> =
    queries.map { RecentSearchDto(it, "now") }

  private fun searchable(
    addonKey: String,
    addonName: String,
    type: String = "movie",
    id: String = "top",
    name: String = id,
    globalSearch: Boolean = true,
  ) = SearchableCatalogDto(addonKey, addonName, globalSearch, type, id, name)

  private fun chooseCatalogSource() {
    focus(globalSearchFilterTag("source_catalog"))
    press(Key.DirectionCenter)
  }

  private fun openScopePanel() {
    focus(TagGlobalSearchScopeChip)
    press(Key.DirectionCenter)
    compose.waitForIdle()
  }

  private fun assertCardBefore(first: String, second: String) {
    val firstBounds = compose.onNodeWithTag(globalSearchCardTag(first)).fetchSemanticsNode().boundsInRoot
    val secondBounds = compose.onNodeWithTag(globalSearchCardTag(second)).fetchSemanticsNode().boundsInRoot
    assertTrue(
      "$first is before $second",
      firstBounds.top < secondBounds.top || firstBounds.top == secondBounds.top && firstBounds.left < secondBounds.left,
    )
  }

  @Test
  fun `typing waits for Done before starting a search`() {
    val api = FakeTvApi()
    mount(api)

    focus(TagGlobalSearchField)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagGlobalSearchInput).performTextInput("matrix")
    compose.waitForIdle()
    assertEquals(0, api.globalStartCalls.size)

    compose.onNodeWithTag(TagGlobalSearchInput).performImeAction()
    compose.waitForIdle()
    assertEquals("matrix", api.globalStartCalls.single().query)
  }

  @Test
  fun `recent searches show on an empty field`() {
    val api = FakeTvApi()
    api.searchStateValue = SearchStateDto(recent = recent("Heat", "Ronin"))
    mount(api)

    compose.onNodeWithText("Recent search").assertIsDisplayed()
    compose.onNodeWithTag(recentSearchTag("Heat")).assertIsDisplayed()
    compose.onNodeWithTag(recentSearchTag("Ronin")).assertIsDisplayed()
  }

  @Test
  fun `OK on a recent search submits it`() {
    val api = FakeTvApi()
    api.searchStateValue = SearchStateDto(recent = recent("Heat", "Ronin"))
    mount(api)

    focus(recentSearchTag("Heat"))
    press(Key.DirectionCenter)

    assertEquals("Heat", api.globalStartCalls.single().query)
    compose.onNodeWithTag(TagSearchRecentList).assertDoesNotExist()
  }

  @Test
  fun `the cross forgets one recent search`() {
    val api = FakeTvApi()
    api.searchStateValue = SearchStateDto(recent = recent("Heat", "Ronin"))
    mount(api)

    focus(recentSearchTag("Heat"))
    press(Key.DirectionRight)
    compose.onNodeWithTag(recentRemoveTag("Heat")).assertIsFocused()
    press(Key.DirectionCenter)

    assertEquals(listOf("Heat"), api.forgottenSearches)
    compose.onNodeWithTag(recentSearchTag("Heat")).assertDoesNotExist()
    compose.onNodeWithTag(recentSearchTag("Ronin")).assertExists()
  }

  @Test
  fun `typing hides the recent list`() {
    val api = FakeTvApi()
    api.searchStateValue = SearchStateDto(recent = recent("Heat", "Ronin"))
    mount(api)

    focus(TagGlobalSearchField)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagGlobalSearchInput).performTextInput("mat")
    compose.waitForIdle()

    compose.onNodeWithTag(TagSearchRecentList).assertDoesNotExist()
  }

  @Test
  fun `Down from the field reaches the first recent search`() {
    val api = FakeTvApi()
    api.searchStateValue = SearchStateDto(recent = recent("Heat", "Ronin"))
    mount(api)

    focus(TagGlobalSearchField)
    for (attempt in 1..3) {
      if (focused(recentSearchTag("Heat"))) break
      press(Key.DirectionDown)
    }
    compose.onNodeWithTag(recentSearchTag("Heat")).assertIsFocused()

    press(Key.DirectionUp)

    compose.onNodeWithTag(recentSearchTag("Heat")).assertIsNotFocused()
    compose.onNodeWithTag(globalSearchFilterTag("kind_all")).assertIsFocused()
    press(Key.DirectionUp)
    compose.onNodeWithTag(globalSearchFilterTag("source_all")).assertIsFocused()
  }

  @Test
  fun `a submitted search is remembered`() {
    val api = FakeTvApi()
    mount(api)

    search("matrix")

    assertEquals(listOf("matrix"), api.recordedSearches)
  }

  @Test
  fun `a library-scoped search keeps no history`() {
    val api = FakeTvApi()
    api.searchStateValue = SearchStateDto(recent = recent("Heat", "Ronin"))
    val scope = LibrarySearchScope(
      library = GlobalSearchLibraryDto("lib1", path = "Shows"),
      sources = listOf("local"),
      title = "Films  ›  Shows",
    )
    mount(api, libraryScope = scope)

    compose.onNodeWithTag(TagSearchRecentList).assertDoesNotExist()
    assertEquals(0, api.searchStateCalls)

    search("matrix")

    assertTrue(api.recordedSearches.isEmpty())
  }

  @Test
  fun `a library scope starts fixed, hides the filters and returns on Back`() {
    val api = FakeTvApi()
    start(api, listOf(cluster("c1", "m1", title = "One")))
    var backs = 0
    val scope = LibrarySearchScope(
      library = GlobalSearchLibraryDto("lib1", path = "Shows"),
      sources = listOf("local"),
      title = "Films  ›  Shows",
    )
    mount(api, libraryScope = scope, onBack = { backs++ })
    compose.onNodeWithTag(globalSearchFilterTag("source_all")).assertDoesNotExist()
    compose.onNodeWithTag(TagGlobalSearchScopeChip).assertDoesNotExist()
    compose.onNodeWithText(
      androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        .getString(cz.stremiooffline.tv.R.string.tv_library_search_scope, scope.title),
    ).assertExists()
    // The hint speaks of this library, not of catalogues and libraries in general.
    val context = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
    compose.onNodeWithText(context.getString(cz.stremiooffline.tv.R.string.tv_global_search_library_hint)).assertExists()
    compose.onNodeWithText(context.getString(cz.stremiooffline.tv.R.string.tv_global_search_hint)).assertDoesNotExist()
    // The page opens ready to type: the field has the remote.
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()
    compose.onNodeWithTag(TagGlobalSearchField).assertIsFocused()

    search("matrix")
    compose.waitUntil(5_000) { api.globalStartCalls.isNotEmpty() }
    val body = api.globalStartCalls.single()
    assertEquals("matrix", body.query)
    assertEquals(GlobalSearchLibraryDto("lib1", path = "Shows"), body.library)
    assertEquals(listOf("local"), body.sources)

    compose.waitForIdle()
    focus(globalSearchCardTag("m1"))
    compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()
    assertEquals(1, backs)
  }

  @Test
  fun `the library scope keeps the page's own voice search`() {
    val api = FakeTvApi()
    start(api, listOf(cluster("c1", "m1", title = "One")))
    val voice = Voice()
    val scope = LibrarySearchScope(
      library = GlobalSearchLibraryDto("lib1", path = "Shows"),
      sources = listOf("local"),
      title = "Films  ›  Shows",
    )
    mount(api, libraryScope = scope, voiceAvailable = true, voiceLauncher = { voice.calls += it })

    focus(TagGlobalSearchVoice)
    press(Key.DirectionCenter)
    voice.answer("heat")
    compose.waitForIdle()

    val body = api.globalStartCalls.single()
    assertEquals("heat", body.query)
    assertEquals(GlobalSearchLibraryDto("lib1", path = "Shows"), body.library)
    assertEquals(listOf("local"), body.sources)
  }

  @Test
  fun `the scope chip appears only with the catalog source`() {
    val api = FakeTvApi()
    mount(api)

    compose.onNodeWithTag(TagGlobalSearchScopeChip).assertDoesNotExist()
    chooseCatalogSource()
    compose.onNodeWithTag(TagGlobalSearchScopeChip).assertExists().assertTextContains("all addons", substring = true)

    focus(globalSearchFilterTag("source_local"))
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagGlobalSearchScopeChip).assertDoesNotExist()
  }

  @Test
  fun `source and kind rows are completely reachable before results`() {
    val api = FakeTvApi()
    api.searchableValue = listOf(searchable("a", "Alpha"))
    mount(api)

    focus(TagGlobalSearchField)
    press(Key.DirectionDown)
    compose.onNodeWithTag(globalSearchFilterTag("source_all")).assertIsFocused()
    press(Key.DirectionRight)
    compose.onNodeWithTag(globalSearchFilterTag("source_catalog")).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.searchableCalls == 1 }
    press(Key.DirectionRight)
    compose.onNodeWithTag(globalSearchFilterTag("source_local")).assertIsFocused()
    press(Key.DirectionRight)
    compose.onNodeWithTag(globalSearchFilterTag("source_remote")).assertIsFocused()
    press(Key.DirectionLeft)
    compose.onNodeWithTag(globalSearchFilterTag("source_local")).assertIsFocused()

    focus(globalSearchFilterTag("source_catalog"))
    press(Key.DirectionDown)
    compose.onNodeWithTag(globalSearchFilterTag("kind_all")).assertIsFocused()
    press(Key.DirectionRight)
    compose.onNodeWithTag(globalSearchFilterTag("kind_movie")).assertIsFocused()
    press(Key.DirectionRight)
    compose.onNodeWithTag(globalSearchFilterTag("kind_series")).assertIsFocused()
    press(Key.DirectionDown)
    compose.onNodeWithTag(TagGlobalSearchScopeChip).assertIsFocused().assertIsDisplayed()
    press(Key.DirectionUp)
    compose.onNodeWithTag(globalSearchFilterTag("kind_all")).assertIsFocused()
  }

  @Test
  fun `selecting Catalog loads searchable names without opening the scope panel`() {
    val api = FakeTvApi()
    api.searchableValue = listOf(searchable("a", "Alpha"))
    mount(api)

    chooseCatalogSource()
    compose.waitUntil(5_000) { api.searchableCalls == 1 }

    compose.onNodeWithTag(TagGlobalSearchScopeChip).assertTextContains("all addons", substring = true)
  }

  @Test
  fun `a restored Catalog scope loads its persisted label after recomposition`() {
    val api = FakeTvApi()
    val gate = CompletableDeferred<Unit>()
    api.searchableGate = gate
    api.searchableValue = listOf(searchable("a", "Alpha"))
    val restored = ViewModelProvider(
      compose.activity,
      GlobalSearchViewModel.factory(api),
    )[GlobalSearchViewModel::class.java]
    restored.setScope(SearchScope(addonKey = "a"))

    mount(api)
    gate.complete(Unit)
    compose.waitUntil(5_000) {
      compose.onAllNodes(androidx.compose.ui.test.hasText("Alpha", substring = true))
        .fetchSemanticsNodes().isNotEmpty()
    }

    compose.onNodeWithTag(TagGlobalSearchScopeChip).assertTextContains("Alpha", substring = true)
  }

  @Test
  fun `the first result returns to the filter columns`() {
    val api = FakeTvApi()
    start(api, listOf(cluster("c1", "m1", title = "One")))
    mount(api)
    search()

    focus(globalSearchCardTag("m1"))
    press(Key.DirectionUp)
    compose.onNodeWithTag(TagGlobalSearchSourceStrip).assertIsFocused()
    press(Key.DirectionUp)
    compose.onNodeWithTag(globalSearchFilterTag("kind_all")).assertIsFocused()
    press(Key.DirectionUp)
    compose.onNodeWithTag(globalSearchFilterTag("source_all")).assertIsFocused()
  }

  @Test
  fun `picking an addon re-submits the query with its scope`() {
    val api = FakeTvApi()
    api.searchableValue = listOf(searchable("a", "Alpha"))
    mount(api)
    search()
    chooseCatalogSource()
    openScopePanel()

    focus(scopeAddonTag("a"))
    press(Key.DirectionCenter)
    compose.waitForIdle()

    val request = api.globalStartCalls.last()
    assertEquals("matrix", request.query)
    assertEquals(listOf("catalog"), request.sources)
    assertEquals(SearchScope(addonKey = "a"), request.scope)
    compose.onNodeWithTag(TagGlobalSearchScopeChip).assertTextContains("Alpha", substring = true)
  }

  @Test
  fun `all addons clears the scope and re-submits without one`() {
    val api = FakeTvApi()
    api.searchableValue = listOf(searchable("a", "Alpha"))
    mount(api)
    search()
    chooseCatalogSource()
    openScopePanel()
    focus(scopeAddonTag("a"))
    press(Key.DirectionCenter)
    compose.waitForIdle()

    openScopePanel()
    focus(TagSearchScopeAll)
    press(Key.DirectionCenter)
    compose.waitForIdle()

    val request = api.globalStartCalls.last()
    assertEquals(listOf("catalog"), request.sources)
    assertNull(request.scope)
    compose.onNodeWithTag(TagGlobalSearchScopeChip).assertTextContains("all addons", substring = true)
  }

  @Test
  fun `leaving the catalog source clears the scope`() {
    val api = FakeTvApi()
    api.searchableValue = listOf(searchable("a", "Alpha"))
    mount(api)
    search()
    chooseCatalogSource()
    openScopePanel()
    focus(scopeAddonTag("a"))
    press(Key.DirectionCenter)
    compose.waitForIdle()

    focus(globalSearchFilterTag("source_local"))
    press(Key.DirectionCenter)
    compose.waitForIdle()

    assertNull(api.globalStartCalls.last().scope)
    compose.onNodeWithTag(TagGlobalSearchScopeChip).assertDoesNotExist()

    chooseCatalogSource()
    compose.onNodeWithTag(TagGlobalSearchScopeChip).assertTextContains("all addons", substring = true)
  }

  @Test
  fun `Back closes the scope panel and focuses the chip`() {
    val api = FakeTvApi()
    mount(api)
    chooseCatalogSource()
    openScopePanel()
    compose.onNodeWithTag(TagSearchScopePanel).assertExists()

    compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()

    compose.onNodeWithTag(TagSearchScopePanel).assertDoesNotExist()
    compose.onNodeWithTag(TagGlobalSearchScopeChip).assertIsFocused()
  }

  @Test
  fun `the scope panel reads searchable only on its first open`() {
    val api = FakeTvApi()
    api.searchableValue = listOf(searchable("a", "Alpha"))
    mount(api)
    chooseCatalogSource()
    openScopePanel()
    compose.onNodeWithTag(TagSearchScopePanel).assertExists()
    assertEquals(1, api.searchableCalls)

    compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()
    openScopePanel()

    assertEquals(1, api.searchableCalls)
  }

  @Test
  fun `the D-pad moves from the kind row down to the scope chip`() {
    val api = FakeTvApi()
    mount(api)
    chooseCatalogSource()

    focus(globalSearchFilterTag("kind_series"))
    press(Key.DirectionDown)
    compose.onNodeWithTag(TagGlobalSearchScopeChip).assertIsFocused()
    press(Key.DirectionUp)
    compose.onNodeWithTag(globalSearchFilterTag("kind_all")).assertIsFocused()
  }

  @Test
  fun `a completed voice result starts the search`() {
    val api = FakeTvApi()
    val voice = Voice()
    mount(api, voiceAvailable = true, voiceLauncher = { voice.calls += it })

    focus(TagGlobalSearchVoice)
    press(Key.DirectionCenter)
    voice.answer("  heat  ")
    compose.waitForIdle()

    assertEquals("heat", api.globalStartCalls.single().query)
  }

  @Test
  fun `appending cards keeps focus on the same anchor`() {
    val api = FakeTvApi()
    start(api, listOf(cluster("c1", "m1", title = "One"), cluster("c2", "m2", title = "Two")))
    val gate = CompletableDeferred<Unit>()
    var next: GlobalSearchPollDto? = null
    api.globalPollHandler = { _, revision ->
      gate.await()
      next.also { next = null } ?: GlobalSearchPollDto(changed = false, revision = revision)
    }
    mount(api)
    search()
    focus(globalSearchCardTag("m1"))

    next = GlobalSearchPollDto(
      changed = true,
      snapshot = snapshot(
        2,
        listOf(cluster("c1", "m1", title = "One"), cluster("c2", "m2", title = "Two"), cluster("c3", "m3", title = "Three")),
      ),
    )
    gate.complete(Unit)
    compose.waitForIdle()

    compose.onNodeWithTag(globalSearchCardTag("m1")).assertIsFocused()
  }

  @Test
  fun `a folder card counts its items and the toggle names what is left`() {
    val api = FakeTvApi()
    val folder = GlobalSearchClusterDto(
      key = "folder",
      kind = "folder",
      title = "GirlsDoPorn",
      memberCount = 1,
      primaryMemberKey = "m1",
      memberKeys = listOf("m1"),
      itemCount = 5,
    )
    val file = GlobalSearchClusterDto(
      key = "file",
      kind = "file",
      title = "818",
      memberCount = 1,
      primaryMemberKey = "m2",
      memberKeys = listOf("m2"),
    )
    api.globalStartHandler = {
      GlobalSearchStartResultDto(id = "gs", snapshot = snapshot(1, listOf(folder), unidentified = listOf(file)))
    }
    mount(api)
    search()

    compose.onNodeWithText("5 items").assertExists()
    compose.onNodeWithTag(TagGlobalSearchUnidentified)
      .assertTextContains("More files and folders", substring = true)
  }

  @Test
  fun `server relevance order is shown until a result card is focused`() {
    val api = FakeTvApi()
    start(api, listOf(cluster("c2", "m2", title = "Two"), cluster("c1", "m1", title = "One")))
    val gate = CompletableDeferred<Unit>()
    var next: GlobalSearchPollDto? = null
    api.globalPollHandler = { _, revision ->
      gate.await()
      next.also { next = null } ?: GlobalSearchPollDto(changed = false, revision = revision)
    }
    mount(api)
    search()
    assertCardBefore("m2", "m1")

    next = GlobalSearchPollDto(
      changed = true,
      snapshot = snapshot(2, listOf(cluster("c1", "m1", title = "One"), cluster("c2", "m2", title = "Two"))),
    )
    gate.complete(Unit)
    compose.waitForIdle()

    assertCardBefore("m1", "m2")
  }

  @Test
  fun `a focused result card stays in place when a later snapshot reorders`() {
    val api = FakeTvApi()
    start(api, listOf(cluster("c2", "m2", title = "Two"), cluster("c1", "m1", title = "One")))
    val gate = CompletableDeferred<Unit>()
    var next: GlobalSearchPollDto? = null
    api.globalPollHandler = { _, revision ->
      gate.await()
      next.also { next = null } ?: GlobalSearchPollDto(changed = false, revision = revision)
    }
    mount(api)
    search()
    focus(globalSearchCardTag("m2"))
    assertCardBefore("m2", "m1")

    next = GlobalSearchPollDto(
      changed = true,
      snapshot = snapshot(2, listOf(cluster("c1", "m1", title = "One"), cluster("c2", "m2", title = "Two"))),
    )
    gate.complete(Unit)
    compose.waitForIdle()

    compose.onNodeWithTag(globalSearchCardTag("m2")).assertIsFocused()
    assertCardBefore("m2", "m1")
  }

  @Test
  fun `a merge keeps focus on the merged card that contains the anchor`() {
    val api = FakeTvApi()
    start(api, listOf(cluster("c1", "m1", title = "One"), cluster("c2", "m2", title = "Two")))
    val gate = CompletableDeferred<Unit>()
    var next: GlobalSearchPollDto? = null
    api.globalPollHandler = { _, revision ->
      gate.await()
      next.also { next = null } ?: GlobalSearchPollDto(changed = false, revision = revision)
    }
    mount(api)
    search()
    focus(globalSearchCardTag("m1"))

    next = GlobalSearchPollDto(
      changed = true,
      snapshot = snapshot(
        2,
        listOf(cluster("c2", "m1", "m2", title = "Merged")),
        aliases = listOf(GlobalSearchAliasDto("c1", "c2")),
      ),
    )
    gate.complete(Unit)
    compose.waitForIdle()

    compose.onNodeWithTag(globalSearchCardTag("m1")).assertIsFocused()
  }

  @Test
  fun `a split keeps focus on the side containing the anchor`() {
    val api = FakeTvApi()
    start(api, listOf(cluster("cOld", "m1", "m2", title = "Both")))
    val gate = CompletableDeferred<Unit>()
    var next: GlobalSearchPollDto? = null
    api.globalPollHandler = { _, revision ->
      gate.await()
      next.also { next = null } ?: GlobalSearchPollDto(changed = false, revision = revision)
    }
    mount(api)
    search()
    focus(globalSearchCardTag("m1"))

    next = GlobalSearchPollDto(
      changed = true,
      snapshot = snapshot(
        2,
        listOf(cluster("cNewB", "m2", title = "Two"), cluster("cNewA", "m1", title = "One")),
        aliases = listOf(GlobalSearchAliasDto("cOld", "cNewB")),
      ),
    )
    gate.complete(Unit)
    compose.waitForIdle()

    compose.onNodeWithTag(globalSearchCardTag("m1")).assertIsFocused()
  }

  @Test
  fun `a partial snapshot leaves focus in the filter row`() {
    val api = FakeTvApi()
    start(api, listOf(cluster("c1", "m1")))
    val gate = CompletableDeferred<Unit>()
    var next: GlobalSearchPollDto? = null
    api.globalPollHandler = { _, revision ->
      gate.await()
      next.also { next = null } ?: GlobalSearchPollDto(changed = false, revision = revision)
    }
    mount(api)
    search()
    focus(globalSearchFilterTag("kind_movie"))

    next = GlobalSearchPollDto(
      changed = true,
      snapshot = snapshot(2, listOf(cluster("c1", "m1"), cluster("c2", "m2")), state = "partial"),
    )
    gate.complete(Unit)
    compose.waitForIdle()

    compose.onNodeWithTag(globalSearchFilterTag("kind_movie")).assertIsFocused()
  }

  @Test
  fun `retry is reachable with the D-pad and calls the source retry`() {
    val api = FakeTvApi()
    api.globalStartHandler = {
      GlobalSearchStartResultDto(
        id = "gs",
        snapshot = snapshot(1, listOf(cluster("c1", "m1")), sources = listOf(source("broken", "failed", retryable = true))),
      )
    }
    mount(api)
    search()

    focus(TagGlobalSearchSourceStrip)
    press(Key.DirectionCenter)
    press(Key.DirectionDown)
    press(Key.DirectionRight)
    compose.onNodeWithTag(globalSearchSourceRetryTag("broken")).assertIsFocused()
    press(Key.DirectionCenter)

    assertEquals(listOf("gs" to "broken"), api.globalRetryCalls)
  }

  @Test
  fun `Back closes the chooser and returns focus to the anchor card`() {
    val api = FakeTvApi()
    start(api, listOf(cluster("c1", "m1", title = "One")))
    api.globalMembersHandler = { _, _, _ ->
      GlobalSearchMemberPageDto(
        clusterKey = "c1",
        members = listOf(
          member("m1"),
          member("m2", locator = GlobalSearchLocatorDto(kind = "local", key = "lib/one", libraryId = "lib", itemKind = "folder")),
        ),
      )
    }
    mount(api)
    search()
    focus(globalSearchCardTag("m1"))
    press(Key.DirectionCenter)
    compose.waitForIdle()
    compose.onNodeWithTag(TagGlobalSearchChooser).assertExists()

    compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()

    compose.onNodeWithTag(TagGlobalSearchChooser).assertDoesNotExist()
    compose.onNodeWithTag(globalSearchCardTag("m1")).assertIsFocused()
  }

  @Test
  fun `a title with a shared id opens its title page without asking`() {
    val api = FakeTvApi()
    start(api, listOf(cluster("c1", "m1", "m2", title = "One")))
    api.globalMembersHandler = { _, _, _ ->
      GlobalSearchMemberPageDto(
        clusterKey = "c1",
        members = listOf(
          member("m1"),
          member("m2", locator = GlobalSearchLocatorDto(kind = "local", key = "lib/one", libraryId = "lib", itemKind = "folder")),
        ),
        canonical = GlobalSearchCanonicalDto("movie", "tt1", "One"),
      )
    }
    mount(api)
    search()
    focus(globalSearchCardTag("m1"))
    press(Key.DirectionCenter)
    compose.waitForIdle()

    compose.onNodeWithTag(TagGlobalSearchChooser).assertDoesNotExist()
    assertEquals("tt1", catalogOpened?.meta?.id)
    assertEquals("movie", catalogOpened?.type)
  }

  @Test
  fun `a series card opens the series itself, not one of its episodes`() {
    val api = FakeTvApi()
    start(api, listOf(cluster("c1", "m1", title = "Jiste pane ministře").copy(kind = "series")))
    val series = member("m1", locator = GlobalSearchLocatorDto(kind = "remote", libraryId = "lib", itemId = "s9", itemType = "series", provider = "jellyfin")).copy(kind = "series")
    val episode = member("e1", locator = GlobalSearchLocatorDto(kind = "remote", libraryId = "lib", itemId = "e1", itemType = "episode", provider = "jellyfin")).copy(kind = "episode", season = 1, episode = 1)
    api.globalMembersHandler = { _, _, _ -> GlobalSearchMemberPageDto(clusterKey = "c1", members = listOf(series, episode)) }
    api.remoteItemValues["lib:s9"] = RemoteItemDetailDto(RemoteItemDto(id = "s9", name = "Jiste pane ministře", type = "series"))
    mount(api)
    search()
    focus(globalSearchCardTag("m1"))
    press(Key.DirectionCenter)
    compose.waitForIdle()

    compose.onNodeWithTag(TagGlobalSearchChooser).assertDoesNotExist()
    assertEquals(listOf("lib" to "s9"), api.remoteItemRequests)
    assertEquals("s9", remoteOpened?.item?.id)
  }

  @Test
  fun `several catalogues of one addon are one copy that opens directly`() {
    val api = FakeTvApi()
    start(api, listOf(cluster("c1", "m1", title = "One")))
    api.globalMembersHandler = { _, _, _ ->
      GlobalSearchMemberPageDto(
        clusterKey = "c1",
        members = listOf(
          member(
            "m1",
            locator = GlobalSearchLocatorDto(kind = "catalog", addonKey = "a", type = "movie", id = "tt9", catalogId = "films"),
          ),
          member(
            "m2",
            locator = GlobalSearchLocatorDto(kind = "catalog", addonKey = "a", type = "movie", id = "tt9", catalogId = "netflix"),
          ),
        ),
      )
    }
    mount(api)
    search()
    focus(globalSearchCardTag("m1"))
    press(Key.DirectionCenter)
    compose.waitForIdle()

    compose.onNodeWithTag(TagGlobalSearchChooser).assertDoesNotExist()
    assertEquals("tt9", catalogOpened?.meta?.id)
    assertEquals("movie", catalogOpened?.meta?.type)
    assertEquals("Catalog", catalogOpened?.addonName)
  }

  @Test
  fun `a single remote copy is hydrated before its detail opens`() {
    val api = FakeTvApi()
    start(api, listOf(cluster("c1", "m1", title = "One")))
    api.globalMembersHandler = { _, _, _ ->
      GlobalSearchMemberPageDto(
        clusterKey = "c1",
        members = listOf(
          member(
            "m1",
            locator = GlobalSearchLocatorDto(
              kind = "remote",
              libraryId = "lib",
              itemId = "item",
              provider = "jellyfin",
            ),
          ),
        ),
      )
    }
    api.remoteItemValues["lib:item"] = RemoteItemDetailDto(RemoteItemDto(id = "item", name = "One", type = "movie"))
    mount(api)
    search()
    focus(globalSearchCardTag("m1"))
    press(Key.DirectionCenter)
    compose.waitForIdle()

    assertEquals(listOf("lib" to "item"), api.remoteItemRequests)
    assertEquals("jellyfin", remoteOpened?.provider)
    assertEquals("Catalog", remoteOpened?.libraryName)
    assertEquals("item", remoteOpened?.item?.id)
    assertNull(libraryOpened)
  }

  private fun member(
    key: String,
    locator: GlobalSearchLocatorDto = GlobalSearchLocatorDto(kind = "catalog", type = "movie", id = key),
  ) = GlobalSearchMemberDto(
    memberKey = key,
    sourceId = "src",
    sourceClass = "catalog",
    sourceLabel = "Catalog",
    kind = "movie",
    title = "Member $key",
    locator = locator,
  )
}
