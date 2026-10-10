package cz.stremiooffline.tv.ui.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlayerKeysTest {

  @Test
  fun `back hides the controls first and leaves only on the second press`() {
    val first = playerKeyIntent(PlayerKey.Back, controlsShown = true)
    assertEquals(PlayerKeyIntent(hideControls = true), first)

    val second = playerKeyIntent(PlayerKey.Back, controlsShown = false)
    assertTrue(second!!.exit)
  }

  @Test
  fun `with the controls hidden OK pauses and shows them`() {
    val intent = playerKeyIntent(PlayerKey.Center, controlsShown = false)!!
    assertTrue(intent.pausePlayback)
    assertTrue(intent.showControls)
    assertTrue(!intent.exit)
  }

  @Test
  fun `with the controls hidden left and right seek, the distance growing with the hold`() {
    assertEquals(-1, playerKeyIntent(PlayerKey.Left, controlsShown = false)!!.seekDirection)
    assertEquals(1, playerKeyIntent(PlayerKey.Right, controlsShown = false)!!.seekDirection)
    assertTrue(playerKeyIntent(PlayerKey.Up, controlsShown = false)!!.showControls)
  }

  @Test
  fun `a seek step is ten seconds, then thirty, sixty and two minutes`() {
    assertEquals(10.0, seekStep(0), 0.0)
    assertEquals(10.0, seekStep(999), 0.0)
    assertEquals(30.0, seekStep(1_000), 0.0)
    assertEquals(30.0, seekStep(2_999), 0.0)
    assertEquals(60.0, seekStep(3_000), 0.0)
    assertEquals(60.0, seekStep(5_999), 0.0)
    assertEquals(120.0, seekStep(6_000), 0.0)
    assertEquals(120.0, seekStep(120_000), 0.0)
  }

  @Test
  fun `with the controls shown the pad belongs to the focused control`() {
    assertNull(playerKeyIntent(PlayerKey.Left, controlsShown = true))
    assertNull(playerKeyIntent(PlayerKey.Right, controlsShown = true))
    assertNull(playerKeyIntent(PlayerKey.Center, controlsShown = true))
    assertNull(playerKeyIntent(PlayerKey.Up, controlsShown = true))
  }
}
