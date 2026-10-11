package cz.stremiooffline.tv.diagnostics

import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class AppLogTest {

  @Before
  fun reset() {
    AppLog.clear()
  }

  @Test
  fun `the buffer keeps only the newest thousand lines`() {
    repeat(1500) { AppLog.record("INFO", "line $it") }

    assertEquals(1000, AppLog.size)
    assertEquals("line 500", AppLog.snapshot().first().message)
    assertEquals("line 1499", AppLog.snapshot().last().message)
  }

  @Test
  fun `a crash is written, read back and then dropped`() {
    val file = AppLog.crashFile(Files.createTempDirectory("applog").toFile())
    assertNull(AppLog.readCrash(file))

    AppLog.writeCrash(file, "main", RuntimeException("boom"))

    assertTrue(AppLog.readCrash(file)!!.contains("boom"))
    AppLog.clearCrash(file)
    assertNull(AppLog.readCrash(file))
  }

  @Test
  fun `the crash handler records the crash and the bundle carries it first`() {
    val file = AppLog.crashFile(Files.createTempDirectory("applog").toFile())
    val handler = AppLog.crashHandler(file, null)

    handler.uncaughtException(Thread("worker"), IllegalStateException("boom"))

    val crash = AppLog.readCrash(file)
    assertTrue(crash!!.contains("boom"))
    val lines = AppLog.bundleLines(crash)
    assertEquals("ERROR", lines.first().level)
    assertTrue(lines.first().message.contains("boom"))
    assertTrue(AppLog.snapshot().any { it.level == "ERROR" && it.message == "Uncaught exception" })
  }

  @Test
  fun `a warning for one key goes out only once per window`() {
    assertTrue(AppLog.allowWarn("player:Network", now = 1_000))
    assertFalse(AppLog.allowWarn("player:Network", now = 30_000))
    assertTrue(AppLog.allowWarn("player:Network", now = 61_000))
    assertTrue(AppLog.allowWarn("player:Decoder", now = 30_000))
  }

  /** The server caps a bundle at a thousand lines. A buffer that is full -- which is what a crash
   *  leaves behind -- plus the crash line was a hundred and one over that, so the one bundle that
   *  exists for a crash could never be filed. */
  @Test
  fun `a full buffer plus the crash line still fits the thousand line cap`() {
    repeat(AppLog.CAPACITY) { AppLog.record("INFO", "line $it") }

    val lines = AppLog.bundleLines("Uncaught exception on main")

    assertEquals(AppLog.CAPACITY, lines.size)
    assertEquals("Uncaught exception on main", lines.first().message)
    // The oldest buffer line made room for the crash; the newest are all still there.
    assertEquals("line 1", lines[1].message)
    assertEquals("line 999", lines.last().message)
  }
}
