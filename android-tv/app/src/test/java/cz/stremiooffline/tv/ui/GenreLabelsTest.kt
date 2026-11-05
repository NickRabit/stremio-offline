package cz.stremiooffline.tv.ui

import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.ui.catalog.metaLine
import cz.stremiooffline.tv.ui.home.heroMetaLine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class GenreLabelsTest {
  @Test
  fun knowsTheCatalogueNamesWhateverTheirCase() {
    assertEquals(R.string.genre_animation, genreResource("animation"))
    assertEquals(R.string.genre_comedy, genreResource("Comedy"))
    assertEquals(R.string.genre_scifi, genreResource("Science Fiction"))
    assertEquals(R.string.genre_scifi_fantasy, genreResource("Sci-Fi & Fantasy"))
    assertEquals(R.string.genre_film_noir, genreResource(" Film-Noir "))
  }

  @Test
  fun leavesAnUnknownGenreAlone() {
    assertNull(genreResource("Komedie"))
    assertNull(genreResource("Anime"))
  }

  @Test
  fun theLinesShowGenresThroughTheTranslator() {
    val meta = MetaDto(id = "tt1", type = "series", name = "Simpsonovi", genres = listOf("animation", "comedy"))
    val czech = mapOf("animation" to "Animovaný", "comedy" to "Komedie")
    val translate: (String) -> String = { czech[it] ?: it }
    assertEquals("Animovaný · Komedie", metaLine(meta, translate))
    val card = HomeCard.Tonight(key = "k", label = "Simpsonovi")
    assertEquals("Animovaný · Komedie", heroMetaLine(card, meta, translate))
  }
}
