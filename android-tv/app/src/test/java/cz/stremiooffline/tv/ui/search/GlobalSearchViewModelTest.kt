package cz.stremiooffline.tv.ui.search

import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.GlobalSearchAliasDto
import cz.stremiooffline.tv.data.GlobalSearchClusterDto
import cz.stremiooffline.tv.data.GlobalSearchLibraryDto
import cz.stremiooffline.tv.data.GlobalSearchPollDto
import cz.stremiooffline.tv.data.GlobalSearchSnapshotDto
import cz.stremiooffline.tv.data.GlobalSearchStartResultDto
import cz.stremiooffline.tv.data.RecentSearchDto
import cz.stremiooffline.tv.data.SearchStateDto
import cz.stremiooffline.tv.data.SearchScope
import cz.stremiooffline.tv.ui.FakeTvApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class GlobalSearchViewModelTest {

  private val dispatcher = StandardTestDispatcher()

  @Before fun setUp() = Dispatchers.setMain(dispatcher)

  private var running: GlobalSearchViewModel? = null

  @After
  fun tearDown() {
    running?.setActive(false)
    Dispatchers.resetMain()
  }

  private fun viewModel(api: FakeTvApi): GlobalSearchViewModel =
    GlobalSearchViewModel(api, "slot").also { running = it }

  private fun cluster(key: String, vararg members: String) = GlobalSearchClusterDto(
    key = key,
    kind = "movie",
    title = key,
    memberCount = members.size,
    primaryMemberKey = members.first(),
    memberKeys = members.toList(),
  )

  @Test
  fun `an older start answer cannot replace the newer query`() = runTest(dispatcher) {
    val first = CompletableDeferred<Unit>()
    val api = FakeTvApi()
    api.globalStartHandler = { request ->
      if (request.generation == 1) first.await()
      GlobalSearchStartResultDto(
        id = "gs_${request.generation}",
        snapshot = GlobalSearchSnapshotDto(
          revision = 1,
          state = "complete",
          clusters = listOf(cluster("c${request.generation}", "m${request.generation}")),
        ),
      )
    }
    val viewModel = viewModel(api)
    viewModel.setActive(true)

    viewModel.submit("first")
    runCurrent()
    viewModel.submit("second")
    runCurrent()
    first.complete(Unit)
    runCurrent()

    assertEquals("second", viewModel.state.committed)
    assertEquals(listOf("c2"), viewModel.state.order)
    assertEquals("m2", viewModel.state.snapshot?.clusters?.single()?.memberKeys?.single())
    viewModel.setActive(false)
  }

  @Test
  fun `an unchanged partial answer polls after 250 ms and complete after one second`() = runTest(dispatcher) {
    val api = FakeTvApi()
    api.globalStartHandler = {
      GlobalSearchStartResultDto(
        id = "gs",
        snapshot = GlobalSearchSnapshotDto(revision = 1, state = "partial"),
      )
    }
    val viewModel = viewModel(api)
    viewModel.setActive(true)
    viewModel.submit("matrix")
    runCurrent()
    assertEquals(1, api.globalPollCalls.size)

    advanceTimeBy(249)
    runCurrent()
    assertEquals(1, api.globalPollCalls.size)
    advanceTimeBy(1)
    runCurrent()
    assertEquals(2, api.globalPollCalls.size)

    var changedOnce = true
    api.globalPollHandler = { _, revision ->
      if (changedOnce) {
        changedOnce = false
        GlobalSearchPollDto(
          changed = true,
          snapshot = GlobalSearchSnapshotDto(revision = revision + 1, state = "complete"),
        )
      } else {
        GlobalSearchPollDto(changed = false, revision = revision)
      }
    }
    advanceTimeBy(250)
    runCurrent()
    assertEquals(4, api.globalPollCalls.size)
    advanceTimeBy(999)
    runCurrent()
    assertEquals(4, api.globalPollCalls.size)
    advanceTimeBy(1)
    runCurrent()
    assertEquals(5, api.globalPollCalls.size)
    viewModel.setActive(false)
  }

  @Test
  fun `a 410 restarts once and then keeps the restart error`() = runTest(dispatcher) {
    val api = FakeTvApi()
    api.globalPollHandler = { _, _ -> throw ApiError(ApiFailure.NotFound, status = 410) }
    val viewModel = viewModel(api)
    viewModel.setActive(true)

    viewModel.submit("matrix")
    advanceUntilIdle()

    assertEquals(2, api.globalStartCalls.size)
    assertEquals("matrix", api.globalStartCalls.last().query)
    assertEquals(R.string.tv_global_search_restart_failed, viewModel.state.error)
  }

  @Test
  fun `aliases keep a retired card in place and append new cards in server order`() {
    val previous = listOf("a", "b", "gone")
    val clusters = listOf(cluster("b", "m2"), cluster("a", "m1"), cluster("c", "m3"))
    val aliases = listOf(GlobalSearchAliasDto("gone", "c"))

    assertEquals(listOf("a", "b", "c"), mergeGlobalSearchOrder(previous, clusters, aliases))
  }

  @Test
  fun `server relevance order is adopted until focus and a new filter resets it`() = runTest(dispatcher) {
    val api = FakeTvApi()
    api.globalStartHandler = { request ->
      GlobalSearchStartResultDto(
        id = "gs_${request.generation}",
        snapshot = GlobalSearchSnapshotDto(
          revision = 1,
          state = "complete",
          clusters = if (request.generation == 1) {
            listOf(cluster("b", "m2"), cluster("a", "m1"))
          } else {
            listOf(cluster("d", "m4"), cluster("c", "m3"))
          },
        ),
      )
    }
    var reorder = true
    api.globalPollHandler = { _, revision ->
      if (reorder) {
        reorder = false
        GlobalSearchPollDto(
          changed = true,
          snapshot = GlobalSearchSnapshotDto(
            revision = revision + 1,
            state = "partial",
            clusters = listOf(cluster("c", "m3"), cluster("b", "m2"), cluster("a", "m1")),
          ),
        )
      } else {
        GlobalSearchPollDto(changed = false, revision = revision)
      }
    }
    val viewModel = viewModel(api)
    viewModel.setActive(true)

    viewModel.submit("matrix")
    runCurrent()
    assertEquals(listOf("c", "b", "a"), viewModel.state.order)

    viewModel.setFocusAnchor("m2")
    viewModel.setSources(setOf(SourceClass.Local))
    runCurrent()
    assertEquals(listOf("d", "c"), viewModel.state.order)
    viewModel.setActive(false)
  }

  @Test
  fun `leaving deletes the session and clears every field`() = runTest(dispatcher) {
    val api = FakeTvApi()
    val viewModel = viewModel(api)
    viewModel.setActive(true)
    viewModel.submit("matrix")
    runCurrent()

    viewModel.leave()
    advanceUntilIdle()

    assertEquals(listOf("gs_1"), api.globalDeletedIds)
    assertEquals(GlobalSearchState(), viewModel.state)
    assertNull(viewModel.state.snapshot)
  }

  @Test
  fun `a submitted query is recorded once its first answer arrives`() = runTest(dispatcher) {
    val api = FakeTvApi()
    val viewModel = viewModel(api)
    viewModel.setActive(true)
    viewModel.submit("matrix")
    runCurrent()

    assertEquals(listOf("matrix"), api.recordedSearches)
    assertEquals(listOf("matrix"), viewModel.state.recent.map { it.query })
    viewModel.setActive(false)
  }

  @Test
  fun `a failed start records nothing`() = runTest(dispatcher) {
    val api = FakeTvApi()
    api.globalStartHandler = { throw ApiError(ApiFailure.Generic) }
    val viewModel = viewModel(api)

    viewModel.submit("matrix")
    runCurrent()

    assertTrue(api.recordedSearches.isEmpty())
  }

  @Test
  fun `a filter change re-runs without recording again`() = runTest(dispatcher) {
    val api = FakeTvApi()
    val viewModel = viewModel(api)

    viewModel.submit("matrix")
    runCurrent()
    viewModel.setKind(KindFilter.Movies)
    runCurrent()

    assertEquals(listOf("matrix"), api.recordedSearches)
    assertEquals(2, api.globalStartCalls.size)
  }

  @Test
  fun `All keeps its source classes when a catalog scope is applied`() = runTest(dispatcher) {
    val api = FakeTvApi()
    val viewModel = viewModel(api)

    viewModel.setScope(SearchScope(addonKey = "alpha"))
    viewModel.submit("matrix")
    runCurrent()

    assertTrue(viewModel.state.sources.isEmpty())
    val request = api.globalStartCalls.single()
    assertEquals(listOf("catalog", "local", "remote"), request.sources)
    assertEquals(SearchScope(addonKey = "alpha"), request.scope)
    viewModel.setActive(false)
  }

  @Test
  fun `changing sources keeps a catalog scope only while Catalog remains included`() = runTest(dispatcher) {
    val api = FakeTvApi()
    val viewModel = viewModel(api)
    val scope = SearchScope(addonKey = "alpha")

    viewModel.setScope(scope)
    viewModel.setSources(setOf(SourceClass.Catalog, SourceClass.Local, SourceClass.Remote))
    assertEquals(scope, viewModel.state.scope)
    assertEquals(setOf(SourceClass.Catalog, SourceClass.Local, SourceClass.Remote), viewModel.state.sources)

    viewModel.setSources(setOf(SourceClass.Local))
    assertEquals(SearchScope(), viewModel.state.scope)
  }

  @Test
  fun `Catalog to All preserves the catalog scope and all source classes`() = runTest(dispatcher) {
    val api = FakeTvApi()
    val viewModel = viewModel(api)
    val scope = SearchScope(addonKey = "alpha")

    viewModel.setSources(setOf(SourceClass.Catalog))
    viewModel.setScope(scope)
    viewModel.setSources(emptySet())
    viewModel.submit("matrix")
    runCurrent()

    assertTrue(viewModel.state.sources.isEmpty())
    assertEquals(scope, viewModel.state.scope)
    assertEquals(listOf("catalog", "local", "remote"), api.globalStartCalls.single().sources)
  }

  @Test
  fun `nothing is recorded while saving is off`() = runTest(dispatcher) {
    val api = FakeTvApi()
    api.searchStateValue = SearchStateDto(saveHistory = false)
    val viewModel = viewModel(api)

    viewModel.refreshRecent()
    runCurrent()
    viewModel.submit("matrix")
    runCurrent()

    assertTrue(api.recordedSearches.isEmpty())
  }

  @Test
  fun `forget drops the row and asks the server`() = runTest(dispatcher) {
    val api = FakeTvApi()
    api.searchStateValue = SearchStateDto(
      recent = listOf(RecentSearchDto("a", "now"), RecentSearchDto("b", "then")),
    )
    val viewModel = viewModel(api)
    viewModel.refreshRecent()
    runCurrent()

    viewModel.forget("a")
    runCurrent()

    assertEquals(listOf("a"), api.forgottenSearches)
    assertEquals(listOf("b"), viewModel.state.recent.map { it.query })
  }

  @Test
  fun `a library scope never touches history`() = runTest(dispatcher) {
    val api = FakeTvApi()
    api.searchStateValue = SearchStateDto(recent = listOf(RecentSearchDto("a", "now")))
    val library = GlobalSearchViewModel(
      api,
      "library",
      library = GlobalSearchLibraryDto("lib_ab12cd34", path = "Shows"),
    ).also { running = it }
    val fixedSources = GlobalSearchViewModel(
      api,
      "sources",
      sources = setOf(SourceClass.Local),
    ).also { running = it }

    for (viewModel in listOf(library, fixedSources)) {
      viewModel.refreshRecent()
      viewModel.submit("matrix")
      viewModel.forget("a")
      runCurrent()
    }

    assertEquals(0, api.searchStateCalls)
    assertTrue(api.recordedSearches.isEmpty())
    assertTrue(api.forgottenSearches.isEmpty())
  }

  @Test
  fun `a fixed library scope sends its library and sources and ignores filters`() = runTest(dispatcher) {
    val api = FakeTvApi()
    val viewModel = GlobalSearchViewModel(
      api,
      "slot",
      library = GlobalSearchLibraryDto("lib_ab12cd34", path = "Shows"),
      sources = setOf(SourceClass.Local),
    ).also { running = it }
    viewModel.setActive(true)

    viewModel.setKind(KindFilter.Series)
    viewModel.setSources(setOf(SourceClass.Remote))
    viewModel.submit("hluboky")
    runCurrent()

    val body = api.globalStartCalls.single()
    assertEquals(listOf("local"), body.sources)
    assertEquals(GlobalSearchLibraryDto("lib_ab12cd34", path = "Shows"), body.library)
    assertEquals("all", body.kind)
    viewModel.setActive(false)
  }
}
