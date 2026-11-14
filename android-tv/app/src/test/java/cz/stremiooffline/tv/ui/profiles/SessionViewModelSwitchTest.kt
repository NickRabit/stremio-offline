package cz.stremiooffline.tv.ui.profiles

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.ApiClient
import cz.stremiooffline.tv.data.CookieStore
import cz.stremiooffline.tv.data.ServerAddress
import cz.stremiooffline.tv.data.SessionStore
import cz.stremiooffline.tv.ui.SessionState
import cz.stremiooffline.tv.ui.SessionViewModel
import cz.stremiooffline.tv.ui.shell.Section
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SessionViewModelSwitchTest {

  private val server = MockWebServer()
  private val context: Context = ApplicationProvider.getApplicationContext()

  @Before
  fun mainDispatcher() {
    Dispatchers.setMain(Dispatchers.Unconfined)
  }

  @After
  fun shutdown() {
    Dispatchers.resetMain()
    server.shutdown()
  }

  @Test
  fun `switchedProfile replaces the api instance and the username`() {
    server.start()
    val address = ServerAddress.parse(server.url("/").toString())!!
    val store = MemoryStore(context)
    val session = SessionViewModel(store, context)
    store.serverUrl = address.display
    store.saveSession(address.origin, "old-token")
    val firstApi = ApiClient(address, CookieStore(address.origin, store))
    server.enqueue(MockResponse().setBody("""{"username":"ondra","language":"cs","canSwitch":true}"""))
    session.signedIn("ondra", "cs", Section.Home, firstApi)
    awaitSignedIn(session, "ondra", canSwitch = true)

    store.saveSession(address.origin, "new-token")
    server.enqueue(MockResponse().setBody("""{"username":"jana","language":"en","canSwitch":true}"""))
    server.enqueue(MockResponse().setBody("""{"startView":"catalog"}"""))
    session.switchedProfile()
    val signedIn = awaitSignedIn(session, "jana")
    assertNotSame(firstApi, signedIn.api)
    assertEquals("jana", signedIn.username)
    assertEquals(Section.Catalog, signedIn.start)
    assertTrue(signedIn.canSwitch)
    assertEquals("new-token", store.loadSession(address.origin))
  }

  @Test
  fun `refreshCanSwitch follows an administrator taking the account out of the group`() {
    server.start()
    val address = ServerAddress.parse(server.url("/").toString())!!
    val store = MemoryStore(context)
    val session = SessionViewModel(store, context)
    store.serverUrl = address.display
    store.saveSession(address.origin, "token")
    val api = ApiClient(address, CookieStore(address.origin, store))
    server.enqueue(MockResponse().setBody("""{"username":"ondra","language":"cs","canSwitch":true}"""))
    session.signedIn("ondra", "cs", Section.Home, api)
    awaitSignedIn(session, "ondra", canSwitch = true)

    server.enqueue(MockResponse().setBody("""{"username":"ondra","language":"cs","canSwitch":false}"""))
    session.refreshCanSwitch()
    val signedIn = awaitSignedIn(session, "ondra", canSwitch = false)
    assertSame(api, signedIn.api)
  }

  private fun awaitSignedIn(
    session: SessionViewModel,
    username: String,
    canSwitch: Boolean? = null,
  ): SessionState.SignedIn {
    val deadline = System.currentTimeMillis() + 5_000
    while (System.currentTimeMillis() < deadline) {
      val state = session.state as? SessionState.SignedIn
      if (state?.username == username && (canSwitch == null || state.canSwitch == canSwitch)) return state
      Thread.sleep(25)
    }
    fail("expected signed in as $username, was ${session.state}")
    error("unreachable")
  }

  private class MemoryStore(context: Context) : SessionStore(context) {
    override var serverUrl: String? = null
    private var origin: String? = null
    private var session: String? = null

    override fun loadSession(origin: String): String? = session.takeIf { this.origin == origin }

    override fun saveSession(origin: String, value: String?) {
      this.origin = origin
      session = value
    }

    override fun clearSession() {
      origin = null
      session = null
    }
  }
}
