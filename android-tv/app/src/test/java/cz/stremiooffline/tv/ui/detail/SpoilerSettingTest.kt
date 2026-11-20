package cz.stremiooffline.tv.ui.detail

import androidx.compose.ui.test.junit4.createComposeRule
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.ui.FakeTvApi
import kotlinx.coroutines.CompletableDeferred
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A detail opens with the last known choice, so stills are never sharp while settings load. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SpoilerSettingTest {

  @get:Rule val compose = createComposeRule()

  @After
  fun reset() {
    SpoilerSetting.lastKnown = false
  }

  @Test
  fun `the last known choice holds until the account's answer arrives`() {
    SpoilerSetting.lastKnown = true
    val answer = CompletableDeferred<SettingsResponse>()
    val api = object : FakeTvApi() {
      override suspend fun settings(): SettingsResponse = answer.await()
    }
    var seen: Boolean? = null
    compose.setContent { seen = rememberHideSpoilers(api, "tt1") }
    compose.waitForIdle()
    assertEquals(true, seen)

    answer.complete(SettingsResponse(hideSpoilers = false))
    compose.waitForIdle()
    assertEquals(false, seen)
    assertEquals(false, SpoilerSetting.lastKnown)
  }

  @Test
  fun `a failed answer keeps the last known choice`() {
    SpoilerSetting.lastKnown = true
    val api = object : FakeTvApi() {
      override suspend fun settings(): SettingsResponse = error("offline")
    }
    var seen: Boolean? = null
    compose.setContent { seen = rememberHideSpoilers(api, "tt1") }
    compose.waitForIdle()
    assertEquals(true, seen)
  }
}
