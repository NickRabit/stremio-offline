package cz.stremiooffline.tv.ui.search

import cz.stremiooffline.tv.data.GlobalSearchSnapshotDto
import cz.stremiooffline.tv.data.GlobalSearchStartResultDto
import cz.stremiooffline.tv.ui.FakeTvApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class GlobalSearchPollingTest {

  private val dispatcher = StandardTestDispatcher()
  private var running: GlobalSearchViewModel? = null

  @Before fun setUp() = Dispatchers.setMain(dispatcher)

  @After
  fun tearDown() {
    running?.setActive(false)
    Dispatchers.resetMain()
  }

  @Test
  fun `a complete search backs off after thirty seconds`() = runTest(dispatcher) {
    val api = FakeTvApi()
    api.globalStartHandler = {
      GlobalSearchStartResultDto(
        id = "gs",
        snapshot = GlobalSearchSnapshotDto(revision = 1, state = "complete"),
      )
    }
    val viewModel = GlobalSearchViewModel(api, "slot", now = { testScheduler.currentTime }).also { running = it }
    viewModel.setActive(true)
    viewModel.submit("matrix")
    runCurrent()

    repeat(120) {
      advanceTimeBy(1_000)
      runCurrent()
    }

    viewModel.setActive(false)
    runCurrent()
    assertTrue("${api.globalPollCalls.size} polls in two minutes", api.globalPollCalls.size <= 42)
  }
}
