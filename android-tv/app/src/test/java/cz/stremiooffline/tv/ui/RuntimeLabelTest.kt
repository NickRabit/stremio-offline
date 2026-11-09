package cz.stremiooffline.tv.ui

import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.ui.catalog.metaLine
import cz.stremiooffline.tv.ui.home.heroMetaLine
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** ICU supplies the unit words, so the test runs where the Android ICU is. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RuntimeLabelTest {
  private val czech = Locale.forLanguageTag("cs-CZ")

  @Test
  fun `reads the shapes addons send`() {
    assertEquals(136, runtimeMinutes("136 min"))
    assertEquals(136, runtimeMinutes("2h 16min"))
    assertEquals(136, runtimeMinutes("2 h 16 min"))
    assertEquals(136, runtimeMinutes("PT2H16M"))
    assertEquals(136, runtimeMinutes("136"))
    assertNull(runtimeMinutes("0 min"))
    assertNull(runtimeMinutes("PT"))
    assertNull(runtimeMinutes("N/A"))
    assertNull(runtimeMinutes(null))
  }

  @Test
  fun `a run time reads in hours and minutes instead of a minute count`() {
    assertEquals("2 h 16 min", runtimeLabel("136 min", czech))
    assertEquals("2 h", runtimeLabel("120 min", czech))
    assertEquals("49 min", runtimeLabel("49 min", czech))
  }

  @Test
  fun `a short text it cannot read stays and a long one goes`() {
    assertEquals("ca. 2 Std.", runtimeLabel("ca. 2 Std.", czech))
    assertNull(runtimeLabel("x".repeat(40), czech))
    assertNull(runtimeLabel(" ", czech))
  }

  @Test
  fun `the detail and the home hero lines carry the formatted run time`() {
    val meta = MetaDto(id = "tt1", type = "movie", name = "Matrix", runtime = "136 min")
    assertEquals("2 h 16 min", metaLine(meta, locale = czech))
    assertEquals("2 h 16 min", heroMetaLine(HomeCard.Tonight(key = "k", label = "Matrix"), meta, locale = czech))
  }
}
