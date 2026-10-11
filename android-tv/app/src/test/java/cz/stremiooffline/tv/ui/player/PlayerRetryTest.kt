package cz.stremiooffline.tv.ui.player

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

/** Try again always re-reads the account first, whichever kind of session the error left behind. */
class PlayerRetryTest {

  @Test
  fun `a started session reads the account before it restarts`() = runTest {
    val calls = mutableListOf<String>()

    playerRetry(started = true, readAccount = { calls += "read" }, restart = { calls += "restart" }, startOver = { calls += "start" })

    assertEquals(listOf("read", "restart"), calls)
  }

  @Test
  fun `a session that never answered reads the account before it starts over`() = runTest {
    val calls = mutableListOf<String>()

    playerRetry(started = false, readAccount = { calls += "read" }, restart = { calls += "restart" }, startOver = { calls += "start" })

    assertEquals(listOf("read", "start"), calls)
  }
}
