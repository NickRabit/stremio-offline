package cz.stremiooffline.tv.ui.settings

import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.ui.FakeTvApi
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
}
