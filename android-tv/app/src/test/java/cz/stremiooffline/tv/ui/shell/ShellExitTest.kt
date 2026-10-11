@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

import android.content.Context
import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.requestFocus
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.SessionStore
import cz.stremiooffline.tv.ui.FakeTvApi
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Leaving the app with Back closes it and keeps the stored session; only Sign out in Settings
 * clears it. The rail's confirmed exit used to run the sign-out.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class ShellExitTest {

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
  fun `a confirmed back to exit closes the app and keeps the session`() {
    val store = MemoryStore(ApplicationProvider.getApplicationContext())
    store.serverUrl = "http://server:8090"
    store.saveSession("http://server:8090", "cookie")
    var exits = 0
    var signOuts = 0
    scenario.onActivity { activity ->
      activity.setContent {
        Shell(
          start = Section.Catalog,
          api = FakeTvApi(),
          username = "demo",
          onSignOut = {
            signOuts += 1
            store.clearSession()
          },
          onExitApp = { exits += 1 },
        )
      }
    }
    compose.waitForIdle()

    compose.onNodeWithTag(railTag(Section.Catalog)).requestFocus()
    compose.waitForIdle()
    compose.onNodeWithTag(railTag(Section.Catalog)).assertIsFocused()

    back()
    assertEquals("one back on the rail only arms leaving", 0, exits)

    back()
    assertEquals("the confirmed back closes the app", 1, exits)
    assertEquals("the confirmed back never signs out", 0, signOuts)
    assertEquals(0, store.cleared)
    assertEquals("cookie", store.loadSession("http://server:8090"))
  }

  private fun back() {
    scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()
  }

  /** An in-memory session: Robolectric has no Android Keystore for the encrypted store. */
  private class MemoryStore(context: Context) : SessionStore(context) {
    override var serverUrl: String? = null
    var cleared = 0
    private var saved: Pair<String, String?>? = null

    override fun clearSession() {
      cleared += 1
      saved = null
    }

    override fun loadSession(origin: String): String? = saved?.takeIf { it.first == origin }?.second

    override fun saveSession(origin: String, value: String?) {
      saved = origin to value
    }
  }
}
