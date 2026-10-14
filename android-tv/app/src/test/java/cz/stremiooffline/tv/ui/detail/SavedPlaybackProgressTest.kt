package cz.stremiooffline.tv.ui.detail

import org.junit.Assert.assertEquals
import org.junit.Test

/** Where a saved position stands is arithmetic on the two stored numbers, so it is tested as one. */
class SavedPlaybackProgressTest {

  @Test
  fun `a positive position and duration are a bounded share`() {
    assertEquals(SavedProgress.Fraction(0.5f, 50), savedProgress(50.0, 100.0))
  }

  @Test
  fun `a share over the duration is clamped to the whole bar`() {
    assertEquals(SavedProgress.Fraction(1f, 100), savedProgress(300.0, 100.0))
  }

  @Test
  fun `a positive position with no duration is the elapsed timestamp`() {
    assertEquals(SavedProgress.Elapsed("02:03"), savedProgress(123.0, 0.0))
    assertEquals(SavedProgress.Elapsed("02:03"), savedProgress(123.0, Double.NaN))
  }

  @Test
  fun `zero, negative or non-finite positions show nothing`() {
    assertEquals(SavedProgress.None, savedProgress(0.0, 100.0))
    assertEquals(SavedProgress.None, savedProgress(-1.0, 100.0))
    assertEquals(SavedProgress.None, savedProgress(Double.NaN, 100.0))
    assertEquals(SavedProgress.None, savedProgress(Double.POSITIVE_INFINITY, 100.0))
  }
}
