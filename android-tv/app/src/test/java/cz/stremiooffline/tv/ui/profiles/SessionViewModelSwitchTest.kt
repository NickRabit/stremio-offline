package cz.stremiooffline.tv.ui.profiles

import android.content.Context
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.ApiClient
import cz.stremiooffline.tv.data.AvatarDto
import cz.stremiooffline.tv.data.CookieStore
import cz.stremiooffline.tv.data.ServerAddress
import cz.stremiooffline.tv.data.SessionStore
import cz.stremiooffline.tv.ui.SessionState
import cz.stremiooffline.tv.ui.SessionViewModel
import cz.stremiooffline.tv.ui.shell.Section
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.job
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
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
  private val viewModels = ViewModelStore()
  private var session: SessionViewModel? = null

  @Before
  fun mainDispatcher() {
    Dispatchers.setMain(Dispatchers.Unconfined)
  }

  /**
   * No request of the session may outlive the test: a coroutine still running here would resume
   * after the next test has started, and an uncaught failure from it would be blamed on that test.
   */
  @After
  fun shutdown() {
    val work = session?.viewModelScope?.coroutineContext?.job
    viewModels.clear()
    server.shutdown()
    work?.let { runBlocking { it.join() } }
    Dispatchers.resetMain()
  }

  private fun session(store: SessionStore): SessionViewModel =
    ViewModelProvider.create(viewModels, SessionViewModel.factory(store, context))[SessionViewModel::class]
      .also { session = it }

  /** Waits until every request the session started has answered, then reads its state. */
  private fun settle(session: SessionViewModel): SessionState = runBlocking {
    val work = session.viewModelScope.coroutineContext.job
    while (true) {
      val running = work.children.toList()
      if (running.isEmpty()) break
      running.joinAll()
    }
    session.state
  }

  private fun signedIn(session: SessionViewModel): SessionState.SignedIn {
    val state = settle(session)
    assertTrue("expected a signed-in session, was $state", state is SessionState.SignedIn)
    return state as SessionState.SignedIn
  }

  @Test
  fun `switchedProfile replaces the api instance and the username`() {
    server.start()
    val address = ServerAddress.parse(server.url("/").toString())!!
    val store = MemoryStore(context)
    val session = session(store)
    store.serverUrl = address.display
    store.saveSession(address.origin, "old-token")
    val firstApi = ApiClient(address, CookieStore(address.origin, store))
    server.enqueue(MockResponse().setBody("""{"username":"ondra","language":"cs","canSwitch":true}"""))
    session.signedIn("ondra", "cs", Section.Home, firstApi)
    assertTrue(signedIn(session).canSwitch)

    store.saveSession(address.origin, "new-token")
    server.enqueue(
      MockResponse().setBody(
        """{"username":"jana","language":"en","canSwitch":true,"avatar":{"kind":"preset","id":"fox"}}""",
      ),
    )
    server.enqueue(MockResponse().setBody("""{"startView":"catalog"}"""))
    session.switchedProfile()
    val signedIn = signedIn(session)
    assertNotSame(firstApi, signedIn.api)
    assertEquals("jana", signedIn.username)
    assertEquals(Section.Catalog, signedIn.start)
    assertTrue(signedIn.canSwitch)
    assertEquals(AvatarDto(kind = "preset", id = "fox"), signedIn.avatar)
    assertEquals("new-token", store.loadSession(address.origin))
  }

  @Test
  fun `setAvatar updates the signed-in session`() {
    server.start()
    val address = ServerAddress.parse(server.url("/").toString())!!
    val store = MemoryStore(context)
    store.serverUrl = address.display
    val session = session(store)
    val api = ApiClient(address, CookieStore(address.origin, store))
    server.enqueue(MockResponse().setBody("""{"username":"ondra","language":"cs"}"""))
    session.signedIn("ondra", "cs", Section.Home, api)
    assertEquals("ondra", signedIn(session).username)

    val avatar = AvatarDto(kind = "custom", url = "/api/avatar/usr_1?v=2")
    session.setAvatar(avatar)

    assertEquals(avatar, (session.state as SessionState.SignedIn).avatar)
  }

  @Test
  fun `refreshCanSwitch follows an administrator taking the account out of the group`() {
    server.start()
    val address = ServerAddress.parse(server.url("/").toString())!!
    val store = MemoryStore(context)
    val session = session(store)
    store.serverUrl = address.display
    store.saveSession(address.origin, "token")
    val api = ApiClient(address, CookieStore(address.origin, store))
    server.enqueue(MockResponse().setBody("""{"username":"ondra","language":"cs","canSwitch":true}"""))
    session.signedIn("ondra", "cs", Section.Home, api)
    assertTrue(signedIn(session).canSwitch)

    server.enqueue(MockResponse().setBody("""{"username":"ondra","language":"cs","canSwitch":false}"""))
    session.refreshCanSwitch()
    val signedIn = signedIn(session)
    assertEquals(false, signedIn.canSwitch)
    assertSame(api, signedIn.api)
  }

  @Test
  fun `a child starts on Home instead of the stored start view`() {
    server.start()
    val address = ServerAddress.parse(server.url("/").toString())!!
    val store = MemoryStore(context)
    store.serverUrl = address.display
    store.saveSession(address.origin, "token")
    server.enqueue(MockResponse().setBody("""{"username":"kid","language":"en","child":true}"""))

    val session = session(store)

    val signedIn = signedIn(session)
    assertEquals("kid", signedIn.username)
    assertEquals(Section.Home, signedIn.start)
    assertTrue(signedIn.child)
    assertEquals(1, server.requestCount)
  }

  @Test
  fun `a foreground policy change rebuilds the session and an unchanged read does not`() {
    server.start()
    val address = ServerAddress.parse(server.url("/").toString())!!
    val store = MemoryStore(context)
    store.serverUrl = address.display
    store.saveSession(address.origin, "token")
    server.enqueue(MockResponse().setBody("""{"username":"ondra","language":"cs"}"""))
    server.enqueue(MockResponse().setBody("""{"startView":"library"}"""))

    val session = session(store)
    val initial = signedIn(session)
    assertEquals("ondra", initial.username)

    server.enqueue(MockResponse().setBody("""{"username":"ondra","language":"cs","child":true,"catalogue":true}"""))
    session.refreshPolicy()
    val child = signedIn(session)
    assertTrue(child.child)
    assertTrue(child.catalogue)
    assertEquals(Section.Home, child.start)
    assertNotSame(initial.api, child.api)

    server.enqueue(MockResponse().setBody("""{"username":"ondra","language":"cs","child":true,"catalogue":true}"""))
    session.refreshPolicy()
    assertSame(child.api, signedIn(session).api)
    assertEquals(4, server.requestCount)
  }

  @Test
  fun `a foreground avatar change preserves the session and start section`() {
    server.start()
    val address = ServerAddress.parse(server.url("/").toString())!!
    val store = MemoryStore(context)
    store.serverUrl = address.display
    store.saveSession(address.origin, "token")
    server.enqueue(MockResponse().setBody("""{"username":"ondra","language":"cs"}"""))
    server.enqueue(MockResponse().setBody("""{"startView":"library"}"""))
    val session = session(store)
    val initial = signedIn(session)
    assertEquals("ondra", initial.username)

    server.enqueue(
      MockResponse().setBody("""{"username":"ondra","language":"cs","avatar":{"kind":"preset","id":"fox"}}"""),
    )
    session.refreshPolicy()
    val updated = signedIn(session)
    assertEquals(AvatarDto(kind = "preset", id = "fox"), updated.avatar)
    assertSame(initial.api, updated.api)
    assertEquals(Section.Library, updated.start)
    assertEquals(3, server.requestCount)
  }

  @Test
  fun `a failed foreground policy read changes nothing`() {
    server.start()
    val address = ServerAddress.parse(server.url("/").toString())!!
    val store = MemoryStore(context)
    store.serverUrl = address.display
    store.saveSession(address.origin, "token")
    server.enqueue(MockResponse().setBody("""{"username":"ondra","language":"cs"}"""))
    server.enqueue(MockResponse().setBody("""{"startView":"home"}"""))

    val session = session(store)
    val initial = signedIn(session)
    assertEquals("ondra", initial.username)

    server.enqueue(MockResponse().setResponseCode(500))
    session.refreshPolicy()
    assertSame(initial.api, signedIn(session).api)
    assertEquals(3, server.requestCount)
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
