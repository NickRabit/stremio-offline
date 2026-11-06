package cz.stremiooffline.tv.ui.signin

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.ApiClient
import cz.stremiooffline.tv.data.CookieStore
import cz.stremiooffline.tv.data.MemorySessionPersistence
import cz.stremiooffline.tv.data.PairingErrorInfo
import cz.stremiooffline.tv.data.PairingFailure
import cz.stremiooffline.tv.data.PairingPollOutcome
import cz.stremiooffline.tv.data.PairingStartOutcome
import cz.stremiooffline.tv.data.ServerAddress
import cz.stremiooffline.tv.data.SessionStore
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.ui.shell.Section
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SignInViewModelTest {
  private val dispatcher = StandardTestDispatcher()
  private val context: Context = ApplicationProvider.getApplicationContext()
  private val address = ServerAddress.parse("http://nas:8090/stremio")!!
  private val api = ApiClient(address, CookieStore(address.origin, MemorySessionPersistence()))

  @Before
  fun mainDispatcher() {
    Dispatchers.setMain(dispatcher)
  }

  @After
  fun restoreDispatcher() {
    Dispatchers.resetMain()
  }

  @Test
  fun `approved pairing adopts the staged cookie and normal bootstrap`() = runTest(dispatcher) {
    val store = MemoryStore(context)
    val transport = FakeTransport(
      polls = ArrayDeque(listOf(PairingPollOutcome.Pending, PairingPollOutcome.Approved("owner", "cs"))),
    )
    var callback: Triple<String, String?, Section>? = null
    var now = 1_000L
    val timed = SignInViewModel(
      store,
      { username, language, section, _ -> callback = Triple(username, language, section) },
      PairingTransportFactory { transport },
      now = { now },
      wait = { now += it },
      deviceLabel = "Test TV",
    )

    timed.reset(address.display, null)
    timed.startPairing()
    advanceUntilIdle()

    assertEquals(Triple("owner", "cs", Section.Home), callback)
    assertEquals(address.display, store.serverUrl)
    assertEquals("tv-token", store.loadSession(address.origin))
    assertEquals(1, transport.settingsCalls)
    assertTrue(transport.started)
  }

  @Test
  fun `polling stops at the original TTL instead of spinning`() = runTest(dispatcher) {
    val store = MemoryStore(context)
    val transport = FakeTransport(
      expiresIn = 12,
      polls = ArrayDeque(List(20) { PairingPollOutcome.Pending }),
    )
    var now = 1_000L
    val viewModel = SignInViewModel(
      store,
      { _, _, _, _ -> error("signed in after expiry") },
      PairingTransportFactory { transport },
      now = { now },
      wait = { now += it },
      deviceLabel = "Test TV",
    )

    viewModel.reset(address.display, null)
    viewModel.startPairing()
    advanceUntilIdle()

    val failed = viewModel.state.pairing as PairingState.Failed
    assertEquals(PairingFailure.Expired, failed.error.failure)
    assertEquals(2, transport.pollCalls)
  }

  @Test
  fun `transport failures use bounded backoff within the TTL`() = runTest(dispatcher) {
    val store = MemoryStore(context)
    val transport = FakeTransport(
      polls = ArrayDeque(listOf(
        PairingPollOutcome.Failed(PairingErrorInfo(PairingFailure.Unreachable)),
        PairingPollOutcome.Pending,
        PairingPollOutcome.Approved("owner", "en"),
      )),
    )
    val waits = mutableListOf<Long>()
    var now = 1_000L
    val viewModel = SignInViewModel(
      store,
      { _, _, _, _ -> },
      PairingTransportFactory { transport },
      now = { now },
      wait = { waits += it; now += it },
      deviceLabel = "Test TV",
    )

    viewModel.reset(address.display, null)
    viewModel.startPairing()
    advanceUntilIdle()

    assertEquals(listOf(5_000L, 10_000L, 5_000L), waits.take(3))
  }

  @Test
  fun `a late approval cannot persist or call back after cancellation`() = runTest(dispatcher) {
    val store = MemoryStore(context)
    val gate = CompletableDeferred<PairingPollOutcome>()
    val transport = FakeTransport(gate = gate)
    var callbacks = 0
    var now = 1_000L
    val viewModel = SignInViewModel(
      store,
      { _, _, _, _ -> callbacks += 1 },
      PairingTransportFactory { transport },
      now = { now },
      wait = { now += it },
      deviceLabel = "Test TV",
    )

    viewModel.reset(address.display, null)
    viewModel.startPairing()
    runCurrent()
    viewModel.cancelPairing()
    gate.complete(PairingPollOutcome.Approved("owner", "en"))
    advanceUntilIdle()

    assertEquals(0, callbacks)
    assertNull(store.serverUrl)
    assertNull(store.loadSession(address.origin))
  }

  @Test
  fun `changing the server cancels a late approval`() = runTest(dispatcher) {
    val store = MemoryStore(context)
    val gate = CompletableDeferred<PairingPollOutcome>()
    val transport = FakeTransport(gate = gate)
    var callbacks = 0
    var now = 1_000L
    val viewModel = SignInViewModel(
      store,
      { _, _, _, _ -> callbacks += 1 },
      PairingTransportFactory { transport },
      now = { now },
      wait = { now += it },
      deviceLabel = "Test TV",
    )

    viewModel.reset(address.display, null)
    viewModel.startPairing()
    runCurrent()
    viewModel.onServerChange("http://other:8090/prefix")
    gate.complete(PairingPollOutcome.Approved("owner", "en"))
    advanceUntilIdle()

    assertEquals(0, callbacks)
    assertNull(store.serverUrl)
  }

  @Test
  fun `unsupported server is terminal and retryable`() = runTest(dispatcher) {
    val store = MemoryStore(context)
    val transport = FakeTransport(
      startOutcome = PairingStartOutcome.Failed(PairingErrorInfo(PairingFailure.Unsupported)),
    )
    val viewModel = viewModel(store, transport) { _, _, _, _ -> }

    viewModel.reset(address.display, null)
    viewModel.startPairing()
    advanceUntilIdle()

    val failed = viewModel.state.pairing as PairingState.Failed
    assertEquals(PairingFailure.Unsupported, failed.error.failure)
    assertEquals(0, transport.pollCalls)
  }

  @Test
  fun `the full display including a reverse proxy prefix reaches the pairing client`() = runTest(dispatcher) {
    val store = MemoryStore(context)
    val transport = FakeTransport(
      polls = ArrayDeque(listOf(PairingPollOutcome.Approved("owner", "en"))),
    )
    val expected = address
    val factory = PairingTransportFactory { seen -> assertEquals(expected.display, seen.display); transport }
    val viewModel = SignInViewModel(store, { _, _, _, _ -> }, factory, deviceLabel = "Test TV")

    viewModel.reset(address.display, null)
    viewModel.startPairing()
    advanceUntilIdle()

    assertEquals(address.display, store.serverUrl)
  }

  @Test
  fun `the qr link keeps a reverse proxy prefix and carries the code`() {
    val prefixed = ServerAddress.parse("https://nas.example/stremio/")!!
    assertEquals("https://nas.example/stremio/?pair=ABCDEF23", pairingLink(prefixed, "ABCDEF23"))
    assertEquals("http://10.0.2.2:8090/?pair=ABCDEF23", pairingLink(ServerAddress.parse("10.0.2.2:8090")!!, "ABCDEF23"))
  }

  private fun viewModel(
    store: MemoryStore,
    transport: FakeTransport,
    callback: (String, String?, Section, ApiClient) -> Unit,
  ) = SignInViewModel(
    store,
    callback,
    PairingTransportFactory { transport },
    now = { 1_000L },
    wait = {},
    deviceLabel = "Test TV",
  )

  private inner class FakeTransport(
    private val startOutcome: PairingStartOutcome = PairingStartOutcome.Started("ABCDEF23", "p".repeat(43), 300, 5),
    private val polls: ArrayDeque<PairingPollOutcome> = ArrayDeque(),
    private val gate: CompletableDeferred<PairingPollOutcome>? = null,
    private val expiresIn: Int = 300,
  ) : PairingTransport {
    override val api: ApiClient = this@SignInViewModelTest.api
    var started = false
    var pollCalls = 0
    var settingsCalls = 0

    override suspend fun start(deviceLabel: String): PairingStartOutcome {
      started = true
      return when (val outcome = startOutcome) {
        is PairingStartOutcome.Started -> outcome.copy(expiresIn = expiresIn)
        else -> outcome
      }
    }

    override suspend fun poll(pollToken: String): PairingPollOutcome {
      pollCalls += 1
      return gate?.await() ?: if (polls.isEmpty()) PairingPollOutcome.Pending else polls.removeFirst()
    }

    override suspend fun settings(): SettingsResponse {
      settingsCalls += 1
      return SettingsResponse(startView = "home", uiLanguage = "cs")
    }

    override fun stagedSession(): String? = "tv-token"
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
