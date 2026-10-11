@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.ApiClient
import cz.stremiooffline.tv.data.CookieStore
import cz.stremiooffline.tv.data.ServerAddress
import cz.stremiooffline.tv.data.SessionStore
import cz.stremiooffline.tv.ui.shell.Section
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Bug: a pick in Settings updated only the locale, so the retained session kept the sign-in
 * language and the recreation the pick forces applied that stale value again. The session is the
 * one place the language lives, so a re-read of it applies the picked one.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class SessionLocaleTest {

  @get:Rule val compose = createComposeRule()

  /** An in-memory session: Robolectric has no Android Keystore for the encrypted store. */
  private class MemoryStore(context: Context) : SessionStore(context) {
    override var serverUrl: String? = null
    override fun clearSession() {}
    override fun loadSession(origin: String): String? = null
    override fun saveSession(origin: String, value: String?) {}
  }

  private fun signedInSession(language: String): SessionViewModel {
    val store = MemoryStore(ApplicationProvider.getApplicationContext())
    val address = ServerAddress.parse("http://server:8090")!!
    val session = SessionViewModel(store)
    session.signedIn("demo", language, Section.Catalog, ApiClient(address, CookieStore(address.origin, store)))
    return session
  }

  @Test
  fun `the picked language is the one a re-read of the session applies`() {
    val session = signedInSession("en")
    val applied = mutableListOf<String?>()
    var generation by mutableIntStateOf(0)

    compose.setContent {
      // The recreation a locale change forces disposes the effect and starts it over.
      key(generation) { SessionLocale(session) { applied += it } }
    }
    compose.waitForIdle()
    assertEquals(listOf("en"), applied)

    // The pick updates the session before the locale is applied.
    session.setLanguage("cs")
    compose.waitForIdle()
    assertEquals(listOf("en", "cs"), applied)

    // The effect runs again from the session's state instead of the sign-in language.
    generation++
    compose.waitForIdle()
    assertEquals("cs", applied.last())
  }
}
