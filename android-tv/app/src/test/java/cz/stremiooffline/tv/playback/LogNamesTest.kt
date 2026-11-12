package cz.stremiooffline.tv.playback

import cz.stremiooffline.tv.data.TrackChange
import org.junit.Assert.assertEquals
import org.junit.Test

/** A release build minifies class names, so what reaches the server log must not be one. */
class LogNamesTest {
  @Test
  fun `every playback error has a stable name for the server log`() {
    assertEquals(
      listOf("decoder", "network", "session", "source-stopped", "expired"),
      listOf(PlaybackError.Decoder, PlaybackError.Network, PlaybackError.Session, PlaybackError.SourceStopped, PlaybackError.Expired).map { it.wire },
    )
  }

  @Test
  fun `every track change has a stable name for the log`() {
    assertEquals(
      listOf("audio", "subtitle", "quality"),
      listOf(TrackChange.Audio(0, 0.0), TrackChange.Subtitle(null, 0.0), TrackChange.Quality(null, 0.0)).map { it.wire },
    )
  }
}
