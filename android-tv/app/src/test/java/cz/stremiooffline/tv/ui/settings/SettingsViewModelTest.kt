package cz.stremiooffline.tv.ui.settings

import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.HomeLayoutDto
import cz.stremiooffline.tv.data.HomeLayoutEntryDto
import cz.stremiooffline.tv.data.HomeLayoutResponseDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.ui.FakeTvApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/** The one-field writes behind the Settings rows: a failure rolls the row back and says so. */
@OptIn(ExperimentalCoroutinesApi::class)
class SettingsViewModelTest {

  private val dispatcher = StandardTestDispatcher()

  @Before fun setUp() = Dispatchers.setMain(dispatcher)

  @After fun tearDown() = Dispatchers.resetMain()

  private fun fake() = FakeTvApi().apply {
    settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", subtitleLanguage = "cs", startView = "home")
  }

  @Test
  fun `a failed write puts the old value back and reports the failure`() = runTest(dispatcher) {
    val api = fake()
    api.settingsFailure = ApiFailure.Forbidden
    val viewModel = SettingsViewModel(api, onLocale = {})
    advanceUntilIdle()
    assertEquals("en", viewModel.state.audioLanguage)

    viewModel.setAudioLanguage("de")
    advanceUntilIdle()

    assertEquals(listOf("audioLanguage" to "de"), api.settingsPatches)
    assertEquals("the row keeps the value the server still has", "en", viewModel.state.audioLanguage)
    assertEquals(ApiFailure.Forbidden, viewModel.state.error)
  }

  @Test
  fun `a write that lands clears an earlier failure`() = runTest(dispatcher) {
    val api = fake()
    api.settingsFailure = ApiFailure.Generic
    val viewModel = SettingsViewModel(api, onLocale = {})
    advanceUntilIdle()
    viewModel.setStartView("library")
    advanceUntilIdle()
    assertEquals(ApiFailure.Generic, viewModel.state.error)

    api.settingsFailure = null
    viewModel.setStartView("library")
    advanceUntilIdle()

    assertNull(viewModel.state.error)
    assertEquals("library", viewModel.state.startView)
  }

  @Test
  fun `saves are serialized so the newest arrangement lands last`() = runTest(dispatcher) {
    val api = fake()
    api.homeLayoutValue = HomeLayoutResponseDto(
      rows = listOf(
        HomeLayoutEntryDto("resume", "builtin", "home.continue"),
        HomeLayoutEntryDto("favorites", "builtin", "home.favorites"),
        HomeLayoutEntryDto("tonight", "builtin", "home.tonight"),
      ),
      layout = HomeLayoutDto(order = listOf("resume", "favorites", "tonight")),
    )
    val gate = CompletableDeferred<Unit>()
    api.homeLayoutPatchGate = gate
    val viewModel = SettingsViewModel(api, onLocale = {})
    advanceUntilIdle()

    viewModel.toggleHomeRow("resume")
    viewModel.flushHomeLayout()
    advanceUntilIdle()
    assertEquals("one PATCH is in flight, not two", 1, api.homeLayoutPatches.size)

    // Two edits while the first PATCH is still in flight; only the newest one waits.
    viewModel.moveHomeRow("tonight", -1)
    viewModel.flushHomeLayout()
    viewModel.moveHomeRowToTop("tonight")
    viewModel.flushHomeLayout()

    gate.complete(Unit)
    advanceUntilIdle()

    assertEquals(2, api.homeLayoutPatches.size)
    assertEquals(listOf("resume"), api.homeLayoutPatches[0]!!.hidden)
    assertEquals(listOf("tonight", "resume", "favorites"), api.homeLayoutPatches[1]!!.order)
  }
}
