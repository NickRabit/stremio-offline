@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Bug 3: `LibraryRoute` took its view model from the Activity's store, so after a sign-out and a
 * new sign-in it reused the previous session's tree and `ApiClient`. The session shell gives each
 * session its own store, cleared when the client changes; the library therefore starts empty.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class SessionScopeTest {

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
  fun `each session owns a fresh, cleared store`() {
    var api by mutableStateOf<Any>(Any())
    val stores = mutableListOf<ViewModelStore>()
    val storeOwners = mutableListOf<ViewModelStoreOwner>()
    scenario.onActivity { activity ->
      activity.setContent {
        val owner = remember(api) {
          object : ViewModelStoreOwner {
            override val viewModelStore = ViewModelStore()
          }
        }
        DisposableEffect(api) { onDispose { owner.viewModelStore.clear() } }
        CompositionLocalProvider(LocalViewModelStoreOwner provides owner) {
          storeOwners += LocalViewModelStoreOwner.current!!
          stores += owner.viewModelStore
        }
      }
    }
    compose.waitForIdle()
    val first = stores.last()

    // A new sign-in is a new session.
    api = Any()
    compose.waitForIdle()
    val second = stores.last()

    assertNotSame("the second session must not reuse the first session's store", first, second)
    assertEquals("the second session's store starts empty", 0, second.keys().size)
    assertNotSame(storeOwners.first(), storeOwners.last())
  }
}
