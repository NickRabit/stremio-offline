package cz.stremiooffline.tv.data

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test

class PairingApiTest {
  private val server = MockWebServer()
  private var started = false

  @After
  fun shutdown() {
    server.shutdown()
  }

  @Test
  fun `start sends the device label and returns the private poll token`() = runTest {
    server.enqueue(
      MockResponse().setResponseCode(201)
        .setBody("""{"code":"ABCDEF23","pollToken":"${"p".repeat(43)}","expiresIn":300,"interval":5}"""),
    )
    val outcome = client().startPairing("Living room TV")

    assertEquals(PairingStartOutcome.Started("ABCDEF23", "p".repeat(43), 300, 5), outcome)
    val request = server.takeRequest()
    assertEquals("/api/auth/pair/start", request.path)
    assertEquals("POST", request.method)
    assertEquals("""{"deviceLabel":"Living room TV"}""", request.body.readUtf8())
  }

  @Test
  fun `pending and approved polling have separate outcomes`() = runTest {
    server.enqueue(MockResponse().setBody("""{"status":"pending"}"""))
    assertEquals(PairingPollOutcome.Pending, client().pollPairing("p".repeat(43)))
    assertEquals("""{"pollToken":"${"p".repeat(43)}"}""", server.takeRequest().body.readUtf8())

    server.enqueue(
      MockResponse()
        .setHeader("set-cookie", "stremio_offline_session=tv-token; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000")
        .setBody("""{"status":"approved","username":"owner","role":"user","language":"cs"}"""),
    )
    assertEquals(PairingPollOutcome.Approved("owner", "cs"), client().pollPairing("p".repeat(43)))
  }

  @Test
  fun `approved cookie stays in the staging jar until explicitly adopted`() = runTest {
    if (!started) { server.start(); started = true }
    val address = ServerAddress.parse(server.url("/").toString())!!
    val staging = CookieStore(address.origin, MemorySessionPersistence())
    val active = MemorySessionPersistence()
    server.enqueue(
      MockResponse()
        .setHeader("set-cookie", "stremio_offline_session=tv-token; Path=/; HttpOnly; SameSite=Lax")
        .setBody("""{"status":"approved","username":"owner","role":"user","language":"en"}"""),
    )
    ApiClient(address, staging).pollPairing("p".repeat(43))

    assertEquals("tv-token", staging.currentSession())
    assertEquals(null, active.loadSession(address.origin))
    active.saveSession(address.origin, staging.currentSession())
    assertEquals("tv-token", active.loadSession(address.origin))
  }

  @Test
  fun `expected refusals are typed instead of becoming infinite retries`() = runTest {
    server.enqueue(MockResponse().setResponseCode(404).setBody("""{"messageKey":"err.invalidRequest"}"""))
    val unsupported = client().startPairing("TV") as PairingStartOutcome.Failed
    assertEquals(PairingFailure.Unsupported, unsupported.error.failure)

    server.enqueue(
      MockResponse().setResponseCode(429).setHeader("Retry-After", "17")
        .setBody("""{"messageKey":"err.tooManyRequests"}"""),
    )
    val busy = client().pollPairing("p".repeat(43)) as PairingPollOutcome.Failed
    assertEquals(PairingFailure.Busy, busy.error.failure)
    assertEquals(17, busy.error.seconds)

    server.enqueue(MockResponse().setResponseCode(410).setBody("""{"messageKey":"err.pairInvalid"}"""))
    val expired = client().pollPairing("p".repeat(43)) as PairingPollOutcome.Failed
    assertEquals(PairingFailure.Expired, expired.error.failure)
  }

  @Test
  fun `restricted and setup answers are actionable`() = runTest {
    server.enqueue(MockResponse().setResponseCode(403).setBody("""{"messageKey":"err.restricted"}"""))
    val restricted = client().startPairing("TV") as PairingStartOutcome.Failed
    assertEquals(PairingFailure.Restricted, restricted.error.failure)

    server.enqueue(MockResponse().setResponseCode(409).setBody("""{"messageKey":"err.noAccount"}"""))
    val setup = client().startPairing("TV") as PairingStartOutcome.Failed
    assertEquals(PairingFailure.NeedsSetup, setup.error.failure)
  }

  private fun client(): ApiClient {
    if (!started) { server.start(); started = true }
    val address = ServerAddress.parse(server.url("/").toString())!!
    return ApiClient(address, CookieStore(address.origin, MemorySessionPersistence()))
  }
}
