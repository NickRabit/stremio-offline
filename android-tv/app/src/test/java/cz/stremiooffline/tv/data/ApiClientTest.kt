package cz.stremiooffline.tv.data

import java.io.ByteArrayInputStream
import java.security.KeyStore
import java.util.Base64
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import kotlinx.coroutines.asCoroutineDispatcher
import org.junit.Test

class ApiClientTest {

  private val server = MockWebServer()

  @After
  fun shutdown() {
    server.shutdown()
  }

  @Test
  fun `status answers with the version`() = runTest {
    server.enqueue(MockResponse().setBody("""{"status":"ok","version":"0.5.36","restricted":false}"""))
    assertEquals("0.5.36", client(start()).status().version)
  }

  @Test
  fun `something that is not the server is incompatible`() = runTest {
    server.enqueue(MockResponse().setBody("<html>hello</html>"))
    assertFailure(ApiFailure.Incompatible) { client(start()).status() }
  }

  @Test
  fun `wrong credentials are told apart`() = runTest {
    server.enqueue(
      MockResponse().setResponseCode(401)
        .setBody("""{"error":"Wrong username or password.","messageKey":"err.badCredentials"}""")
    )
    assertFailure(ApiFailure.BadCredentials) { client(start()).login("demo", "nope") }
  }

  @Test
  fun `being throttled carries the seconds`() = runTest {
    server.enqueue(
      MockResponse().setResponseCode(429)
        .setBody("""{"error":"Too many failed attempts.","messageKey":"err.tooManyAttempts","vars":{"seconds":12}}""")
    )
    try {
      client(start()).login("demo", "nope")
      fail("expected too many attempts")
    } catch (error: ApiError) {
      assertEquals(ApiFailure.TooMany, error.failure)
      assertEquals(12, error.seconds)
    }
  }

  @Test
  fun `a server without an account asks for setup`() = runTest {
    server.enqueue(MockResponse().setBody("""{"setup":true}"""))
    assertEquals(MeResult.Setup, client(start()).me())
  }

  @Test
  fun `sign-in asks to be remembered`() = runTest {
    server.enqueue(MockResponse().setBody("""{"username":"demo","role":"admin","mustChangePassword":false}"""))
    client(start()).login("demo", "secret")
    val request = server.takeRequest()
    val body = request.body.readUtf8()
    assertTrue(body, body.contains("\"remember\":true"))
    assertTrue(body, body.contains("\"username\":\"demo\""))
  }

  @Test
  fun `the session cookie travels to the next request`() = runTest {
    val address = start()
    val cookies = CookieStore(address.origin, Memory())
    server.enqueue(
      MockResponse()
        .setHeader("set-cookie", "stremio_offline_session=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000")
        .setBody("""{"username":"demo","role":"admin"}""")
    )
    client(address, cookies).login("demo", "secret")
    server.takeRequest()
    server.enqueue(MockResponse().setBody("""{"username":"demo","role":"admin"}"""))
    client(address, cookies).me()
    assertEquals("stremio_offline_session=abc", server.takeRequest().getHeader("Cookie"))
  }

  @Test
  fun `an https server refuses to redirect to http`() {
    val tls = tls()
    server.useHttps(tls.socketFactory, false)
    server.start()
    server.enqueue(
      MockResponse().setResponseCode(302).setHeader("Location", "http://localhost:${server.port}/api/status")
    )
    val address = ServerAddress.parse("https://localhost:${server.port}")!!
    val client = OkHttpClient.Builder().sslSocketFactory(tls.socketFactory, tls.trustManager).build()
    val api = ApiClient(address, CookieStore(address.origin, Memory()), client)
    runTest { assertFailure(ApiFailure.Unreachable) { api.status() } }
  }

  @Test
  fun `browse without a path asks for the first page`() = runTest {
    server.enqueue(MockResponse().setBody("""{"path":"","items":[],"total":0,"pending":false}"""))
    client(start()).browse(null)

    assertEquals("/api/library/browse?limit=60&skip=0", server.takeRequest().path)
  }

  @Test
  fun `browse encodes the path`() = runTest {
    server.enqueue(MockResponse().setBody("""{"path":"A B/C","items":[],"total":0,"pending":false}"""))
    client(start()).browse("A B/C")

    assertEquals("/api/library/browse?limit=60&skip=0&path=A%20B%2FC", server.takeRequest().path)
  }

  @Test
  fun `a relative url resolves under the configured prefix`() {
    val address = ServerAddress.parse("http://nas:8090/stremio")!!
    val api = ApiClient(address, CookieStore(address.origin, Memory()))
    assertEquals("http://nas:8090/stremio/api/media/x", api.url("/api/media/x"))
  }

  private fun start(): ServerAddress {
    server.start()
    return ServerAddress.parse(server.url("/").toString())!!
  }

  private fun client(address: ServerAddress, cookies: CookieStore = CookieStore(address.origin, Memory())) =
    ApiClient(address, cookies)

  private suspend fun assertFailure(expected: ApiFailure, block: suspend () -> Unit) {
    try {
      block()
      fail("expected $expected")
    } catch (error: ApiError) {
      assertEquals(expected, error.failure)
    }
  }

  private class Memory : SessionPersistence {
    override fun loadSession(origin: String): String? = null
    override fun saveSession(origin: String, value: String?) = Unit
  }

  private class Tls(val socketFactory: SSLSocketFactory, val trustManager: X509TrustManager)

  private fun tls(): Tls {
    val keyStore = KeyStore.getInstance("PKCS12").apply {
      load(ByteArrayInputStream(Base64.getDecoder().decode(SELF_SIGNED_P12)), PASS.toCharArray())
    }
    val keyManagers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
      .apply { init(keyStore, PASS.toCharArray()) }
    val trustManagers = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
      .apply { init(keyStore) }
    val context = SSLContext.getInstance("TLS")
      .apply { init(keyManagers.keyManagers, trustManagers.trustManagers, null) }
    return Tls(context.socketFactory, trustManagers.trustManagers[0] as X509TrustManager)
  }

  private companion object {
    const val PASS = "android"

    /** A throwaway self-signed certificate for `localhost`, so MockWebServer can speak TLS. */
    const val SELF_SIGNED_P12 = "MIIKJgIBAzCCCdAGCSqGSIb3DQEHAaCCCcEEggm9MIIJuTCCBbAGCSqGSIb3DQEHAaCCBaEEggWdMIIFmTCCBZUGCyqGSIb3DQEMCgECoIIFQDCCBTwwZgYJKoZIhvcNAQUNMFkwOAYJKoZIhvcNAQUMMCsEFHYR3GhR7tuZX3In6AQqRHOKdlNKAgInEAIBIDAMBggqhkiG9w0CCQUAMB0GCWCGSAFlAwQBKgQQ39H7+ghjp5DFzKWqQXssZASCBNAUwii+qRzWsB8/H3aMvlipL2R7m93Mg5ns7NGI/c1BoR8hn2s/SmxHPTTv3HscutjfNa+3VPl4T6tkxaa+KSBb+S32yoCXK1cU5Jy4Nx3RSravnlk/bOJXo4ogA6hssq7/oYYCFGtKVoifO8lBPbdkDuZsVNFKKX7ZlsIPHcp72p7W9yhJaUBYA1rXK9OWsb2te+DRXizam8ffVk0ztNADzmqoXOENHpKguOv95Q8v33bO6Msd1rdbmdP8hEW40PIES0FybXeDHyOLvr7PfU5Zzqem2PHVZlYRrHXpMS75g4e4kSSXkqztXU90IueNTNWE0juGoGFO4YmHPa6e9ys4bNkEYXfrKenaxWxzbloXKqS9csq8o1UgQnY2M78PkYuwznWs6lLC373VUNmKF8FmYqsWaD43gS4U6PhpY1hoTNqBP+lqiETk3PQqljqNG2YecQ9HPEmu6MghYiP+6I7+062Qy+pHCPij38KXkFuN33h1NM8q9st6QpHDllAVhkICHKzVbksS9WDBgbgyBy6XaaW23T/dVkfKEruh+O59X67eCUTVd3AMOnzqCMl5wMZy878T4JPsevqt60BXeEANdxSbe8afXE8XBQyEuHTYSPWghG2rqvgnAgxlkeTQBqzuBTUlXGsAWfWXjr9BWSXmBtQQ9HfDUX8shYUDzZoll1/92t10mfsLd/WD00AsAHFJgLqcrZkbwVG/b1Xy5UycnHVrh2Ww0WFjn/0LQLDMONB4E2F9c9BTKedergYLrW3k3A/3B7Xjt1RDFfEssCOZs1Kd/aFfKm0MJ8jtwkO3wJbyBmNKQ4PlxhVYaHJoUImsZeoub2L082FK4ajlFsw62j1VNeJO6NdIL1FmKD1xKwhXsCy528hqQ7Rj41VoQzYL4RgTT9rNzaboTlkpqXi9jFw2XF9AEa2Qw/RkeCAD8y9fsJSE29nKbLnWOewqfEQPypmYag693V/PO07PT63maYrB+iCW97+liZh0lGROIr1Vsa9YC6EbcmZWk4U7hoWiKAsznKfh8Gx/GxHBVxVh/CFNZkrU5z/URE8Mm89kfB6vPcZ3BXJCVhTaHPVAKoPZzPtynTjunBQaORvk2HYkxXOXqo+YQm58OKM/1NAGoYNTMcUCUSPEpxEH0CeZu2NCZyEHuKet7/jUbBIovTH2UbTs5kuhUtarDxa4mDNJbDR/9w36zvaqpz5l3Fe/ubObsVNJdDNcXUUcJHS76DX+SrT+tSOyYnr2icDKXMlSKv5UgIIKx1fR6FgyjGx7v2oeXtcYvVppqJpYOTGqT5EVkdjAB5hZNSdWVpaDUL6yvBKC8TomVE8BwnEHPmNgzABeUlbugbjmBXnoeDB/QnxlARuFSFgK8G8OXJMmyz25nIXoeTSpg8Zmi7oARdXoIHbaZUDc+F0Ggv6O7slnjMFzIJWhh8Lj08lvQUsZ9e+3pFw1eW6RWNlsc00HnyIvuf3EM10vRoO950gZGCO6k28JIA+LHL2LB84qBT9fFv8HXK6ckMAgbBQzY230jsiTEd1eUrOkNPGm3RNbmpJdYRYl32s+BB+oleyLu7JRKW9IeCF7/l5oTqYUSWod8qfTC+MiQrbxSRXdv+UKIWAID05Q22eFXEm1udQYTdozND+VFTFCMB0GCSqGSIb3DQEJFDEQHg4AbQBvAGMAawB3AGUAYjAhBgkqhkiG9w0BCRUxFAQSVGltZSAxNzkxNjM4OTI3MDI5MIIEAQYJKoZIhvcNAQcGoIID8jCCA+4CAQAwggPnBgkqhkiG9w0BBwEwZgYJKoZIhvcNAQUNMFkwOAYJKoZIhvcNAQUMMCsEFGe8pUWf0ra+asDVsNviWgYdovGKAgInEAIBIDAMBggqhkiG9w0CCQUAMB0GCWCGSAFlAwQBKgQQwnIT8PrfYlt4iN1YbT1CnICCA3AYhuCQliC5xNjAD3pLHAU7sNv9yEti2uT6RH3vtyGzVRIzcED6G3twpHavzHNFvcAJotXvJ1t95A7Mr79eubFIXNubCtWZQ+5ZnZ0kPxmkMvIRHf+MCzz2fg1YbW7BYA8n4F0wiN8c4oGp4kGW8yIJ4kaC59XJhrFwtBJvfZNXH2Hj33OUNWMyVRxo/tdnF509Jx84361IDt8l8n6dR8HurCKluEwq3HvhW4VwFDC7TqorAt0cVrORUR4klmqwoLzSzRyzxqJ26lvzOucB+/n0BO05H+9bD9LRsYweROW4DPdrir/Iis8OxUKshbsmeWFwlOVvUIrT6/iMfBuNvrwGCARA1utaJ/FQGvAQFVH39igfEDYV84fcyXYHBq/o3+B81BtXr4UmLCWnhFnrC7CS8U0PrtYfwyZkGJVluOyniRH/YaIiWUmXyS7Zm2KMJYezfHF1iq5FzxlsCRigbHnWsPh2mgBe/LD1wuGwVLxv8nJivOtgN6csbcLcNdIctX9rdd+uoKA+E0ukVwyf7wnmJlYmBnKNtDgH51KWFBvMR1zxmbJuvT0CfYtrHbTDR9tjgJ9Lby/q1ANy+FJ0lnyaevRN497GuB1XijlGJLJxDLeLUnmy6FxMpsMQZHrZ9JlOAT0Q6EuLah9sgScDnlTwzb8LKVj4iBT4GnqVQ2D1DbkKLRH6vdTUlEa9o9TfaZp4bIJK7TSbm//6Bgt8Kzu4LgyTjTBufMTu4q5FAXXe7cJ8R1P95RPVUMvyBD3g08lK+1KctutSCxL2rrCLlBsAzOYHDx3CSIayk1oFoZdQGKdDCN+Un3LhHTlMbgDWxQWYh9hdXOGN3h6vSPUSdF7SwW2V2E8pwYZsBa5/XCLbvhmzD12fwhsSr3jcbldunSymVyIXqhmakOYNGrm6J+BEUTTkMBW8b6GF4DId8/h2cJi+8RDtgHjCqDQQHdhDfFcABcMTQaSa+Vaa+vk3jnZN7V8lrx7UJ82DzLXLnJFoEj4lfiOHP2wikbvSdj41NnGMJ8qSCdglT9BEiH0woJBllJ95yjs/ECeheq2I1c3nRt+8fJtvktLeJN7kmzvk5n/6inHwupYuA2BfqShmhp9iBYhXtWmldPE76QcdlTmcdgMglw/ob/H7aKfRJZxdu9B0hTlQVR6RZDblFEZ7HcmYME0wMTANBglghkgBZQMEAgEFAAQgd5NoYG5hcCzIb4ghNH5nss1aTo6I93YMAqxbGSyRUfMEFFFUq04imCJ85OAoiEG7lv2QElHVAgInEA=="
  }

  @Test
  fun `an absolute url is left as it is`() {
    val api = ApiClient(ServerAddress.parse("http://server/stremio")!!, CookieStore("http://server:80", Memory()))
    assertEquals("https://cdn.example/a.mkv", api.url("https://cdn.example/a.mkv"))
    assertEquals("http://server/stremio/api/media/x", api.url("/api/media/x"))
  }

  // Bug: the body was read on the caller's thread, which is the main thread in the app; a large
  // catalogue answer then crashed with NetworkOnMainThreadException.
  @Test
  fun `the response body is read off the calling thread`() {
    val server = okhttp3.mockwebserver.MockWebServer()
    server.enqueue(okhttp3.mockwebserver.MockResponse().setBody("{\"path\":\"\",\"items\":[],\"total\":0}").throttleBody(8, 50, java.util.concurrent.TimeUnit.MILLISECONDS))
    server.start()
    val readers = java.util.concurrent.CopyOnWriteArrayList<String>()
    val listener = object : okhttp3.EventListener() {
      override fun responseBodyEnd(call: okhttp3.Call, byteCount: Long) { readers += Thread.currentThread().name }
    }
    val address = ServerAddress.parse(server.url("/").toString())!!
    val api = ApiClient(address, CookieStore(address.origin, Memory()), okhttp3.OkHttpClient.Builder().eventListener(listener).build())
    val caller = java.util.concurrent.Executors.newSingleThreadExecutor { Thread(it, "caller") }.asCoroutineDispatcher()
    try {
      kotlinx.coroutines.runBlocking(caller) { api.browse(null) }
    } finally {
      caller.close()
      server.shutdown()
    }
    assertEquals(1, readers.size)
    assertTrue("read on ${readers[0]}", !readers[0].startsWith("caller"))
  }
}
