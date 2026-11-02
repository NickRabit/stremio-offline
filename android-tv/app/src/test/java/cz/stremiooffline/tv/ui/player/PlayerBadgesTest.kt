package cz.stremiooffline.tv.ui.player

import cz.stremiooffline.tv.data.PlaybackFactsDto
import org.junit.Assert.assertEquals
import org.junit.Test

class PlayerBadgesTest {
  @Test
  fun `shows resolution HDR and audio in order`() {
    assertEquals(
      listOf("4K", "Dolby Vision", "E-AC-3 5.1"),
      playingBadges(PlaybackFactsDto(resolution = 2160, hdr = "dolbyVision", audioCodec = "eac3", audioChannels = 6)),
    )
  }

  @Test
  fun `formats an SDR stereo track`() {
    assertEquals(
      listOf("1080p", "AAC stereo"),
      playingBadges(PlaybackFactsDto(resolution = 1080, audioCodec = "aac", audioChannels = 2)),
    )
  }

  @Test
  fun `keeps an audio badge when channels are unknown`() {
    assertEquals(listOf("Opus"), playingBadges(PlaybackFactsDto(audioCodec = "opus")))
  }

  @Test
  fun `shows no badges without facts`() {
    assertEquals(emptyList<String>(), playingBadges(null))
  }
}
