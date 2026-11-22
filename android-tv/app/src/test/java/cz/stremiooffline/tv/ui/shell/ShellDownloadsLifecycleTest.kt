@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

import android.content.Intent
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.ui.FakeTvApi
import java.time.Duration
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class ShellDownloadsLifecycleTest {

  @get:Rule val compose = createEmptyComposeRule()

  private lateinit var scenario: ActivityScenario<ComponentActivity>

  @Before
  fun launchHost() {
    scenario = ActivityScenario.launch(
      Intent(ApplicationProvider.getApplicationContext(), ComponentActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
  }

  @After
  fun closeHost() {
    scenario.close()
  }

  @Test
  fun `the shell download summary polls only while started`() {
    val api = FakeTvApi()
    scenario.onActivity { activity ->
      activity.setContent { Shell(start = Section.Home, api = api, username = "demo", onSignOut = {}) }
    }
    compose.waitForIdle()
    val foregroundRequests = api.activeDownloadsRequests

    scenario.moveToState(Lifecycle.State.CREATED)
    compose.waitForIdle()
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(60))
    compose.waitForIdle()
    assertEquals(foregroundRequests, api.activeDownloadsRequests)

    scenario.moveToState(Lifecycle.State.STARTED)
    compose.waitForIdle()
    assertEquals(foregroundRequests + 1, api.activeDownloadsRequests)
  }
}
