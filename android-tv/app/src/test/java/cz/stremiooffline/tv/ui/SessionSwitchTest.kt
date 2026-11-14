package cz.stremiooffline.tv.ui

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.TvApi
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A profile switch hands the same `SessionContent` call site a new client. Home starts loading
 * from `LaunchedEffect(Unit)`, so unless the subtree is rebuilt the new account's view model is
 * never started and Home stays on its loading skeleton.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class SessionSwitchTest {

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
  fun `a new client restarts the effects of the whole session tree`() {
    var api by mutableStateOf<TvApi>(FakeTvApi())
    val started = mutableListOf<TvApi>()
    scenario.onActivity { activity ->
      activity.setContent {
        SessionContent(api) {
          LaunchedEffect(Unit) { started += api }
        }
      }
    }
    compose.waitForIdle()

    val switched = FakeTvApi()
    api = switched
    compose.waitForIdle()

    assertEquals(2, started.size)
    assertEquals(switched, started.last())
  }
}
