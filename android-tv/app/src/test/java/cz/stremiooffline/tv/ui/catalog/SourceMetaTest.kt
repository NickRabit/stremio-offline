package cz.stremiooffline.tv.ui.catalog

import cz.stremiooffline.tv.data.BehaviorHintsDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.VideoFactsDto
import org.junit.Assert.assertEquals
import org.junit.Test

class SourceMetaTest {

  @Test
  fun `the meta line appends all video facts`() {
    val stream = StreamDto(
      sourceId = "s1",
      kind = "remote",
      playable = true,
      behaviorHints = BehaviorHintsDto(videoSize = 8_000_000_000.0),
      audioLanguages = listOf("cs"),
      videoFacts = VideoFactsDto(heightPixels = 2160, codec = "hevc", range = "dolbyVision"),
    )

    assertEquals(
      listOf("8.0 GB", "CZ", "2160p", "HEVC", "Dolby Vision"),
      sourceMeta(
        stream = stream,
        titleLanguage = null,
        resolutionValue = "2160p",
        codecLabels = mapOf("hevc" to "HEVC"),
        rangeLabels = mapOf("dolbyVision" to "Dolby Vision"),
      ),
    )
  }

  @Test
  fun `the meta line stays unchanged without video facts`() {
    val stream = StreamDto(
      sourceId = "s1",
      kind = "remote",
      playable = true,
      behaviorHints = BehaviorHintsDto(videoSize = 8_000_000_000.0),
      audioLanguages = listOf("cs"),
    )

    assertEquals(
      listOf("8.0 GB", "CZ"),
      sourceMeta(
        stream = stream,
        titleLanguage = null,
        resolutionValue = null,
        codecLabels = emptyMap(),
        rangeLabels = emptyMap(),
      ),
    )
  }
}
