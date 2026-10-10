package cz.stremiooffline.tv.data

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerAddressTest {

  @Test
  fun `an address without a scheme is http`() {
    assertEquals("http://nas:8090", ServerAddress.parse("nas:8090")!!.display)
    assertEquals("http://nas:8090", ServerAddress.parse("  nas:8090  ")!!.display)
  }

  @Test
  fun `a reverse proxy prefix is kept and resolved`() {
    val address = ServerAddress.parse("https://x.example/so/")!!
    assertEquals("https://x.example/so", address.display)
    assertEquals("https://x.example/so/api/status", address.resolve("/api/status").toString())
  }

  @Test
  fun `unusable addresses are refused`() {
    assertNull(ServerAddress.parse("ftp://x"))
    assertNull(ServerAddress.parse("   "))
  }

  @Test
  fun `an https address never resolves to cleartext`() {
    val address = ServerAddress.parse("https://nas:8090")!!
    assertTrue(address.isDowngrade("http://nas:8090/api/status".toHttpUrl()))
  }
}
