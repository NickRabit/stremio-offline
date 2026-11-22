@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.downloads

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.Lifecycle
import cz.stremiooffline.tv.ui.FakeTvApi
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class DownloadsLifecycleTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  @Test
  fun `background polling pauses and resumes immediately`() {
    val api = FakeTvApi()
    compose.setContent { DownloadsScreen(api) }
    compose.waitForIdle()
    val foregroundRequests = api.downloadsRequests

    compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(60_000)
    compose.waitForIdle()
    assertEquals(foregroundRequests, api.downloadsRequests)

    compose.activityRule.scenario.moveToState(Lifecycle.State.STARTED)
    compose.waitForIdle()
    assertEquals(foregroundRequests + 1, api.downloadsRequests)
  }
}
