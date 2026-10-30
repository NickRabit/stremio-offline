package cz.stremiooffline.tv.ui.components

import org.junit.Assert.assertEquals
import org.junit.Test

class LibraryRootArtTest {

  @Test
  fun `a broken composed mosaic falls through collage own art and icon`() {
    assertEquals(
      listOf(
        LibraryRootArtPhase.Composed,
        LibraryRootArtPhase.Collage,
        LibraryRootArtPhase.OwnPoster,
        LibraryRootArtPhase.Fallback,
      ),
      libraryRootArtPhases("/composed.jpg", listOf("/one.jpg", "/two.jpg", "/three.jpg"), "/own.jpg"),
    )
    assertEquals(
      listOf(LibraryRootArtPhase.Composed, LibraryRootArtPhase.SinglePoster, LibraryRootArtPhase.Fallback),
      libraryRootArtPhases("/composed.jpg", listOf("/one.jpg"), null),
    )
  }
}
