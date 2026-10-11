package cz.stremiooffline.tv.ui.catalog

import cz.stremiooffline.tv.ui.theme.Tokens
import org.junit.Assert.assertEquals
import org.junit.Test

/** The message line's colour comes from the kind of the message, never from its text. */
class CatalogNoticeTest {

  @Test
  fun `a failure is red, a queue is green and a plain note is muted`() {
    assertEquals(Tokens.Red, catalogNoticeColour(CatalogNotice.Failure))
    assertEquals(Tokens.Green, catalogNoticeColour(CatalogNotice.Success))
    assertEquals(Tokens.Muted, catalogNoticeColour(CatalogNotice.Neutral))
  }
}
