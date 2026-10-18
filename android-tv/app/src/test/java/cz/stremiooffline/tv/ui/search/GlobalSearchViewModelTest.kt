package cz.stremiooffline.tv.ui.search

import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.GlobalSearchAliasDto
import cz.stremiooffline.tv.data.GlobalSearchClusterDto
import cz.stremiooffline.tv.data.GlobalSearchPollDto
import cz.stremiooffline.tv.data.GlobalSearchSnapshotDto
import cz.stremiooffline.tv.data.GlobalSearchStartResultDto
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
  fun `global search never touches catalog history`() = runTest(dispatcher) {
    val api = FakeTvApi()
    val viewModel = viewModel(api)
    viewModel.setActive(true)
    viewModel.submit("matrix")
    runCurrent()

    assertEquals(0, api.searchStateCalls)
    assertTrue(api.recordedSearches.isEmpty())
    assertTrue(api.forgottenSearches.isEmpty())
    assertEquals(0, api.clearHistoryCalls)
    viewModel.setActive(false)
  }
}
