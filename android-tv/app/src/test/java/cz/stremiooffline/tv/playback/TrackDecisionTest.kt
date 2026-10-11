package cz.stremiooffline.tv.playback

import cz.stremiooffline.tv.data.ClientCapabilitiesDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TrackDecisionTest {

  private val capabilities = ClientCapabilitiesDto(
    audioDecode = listOf("aac", "ac3"),
    audioPassthrough = listOf("eac3"),
    subtitles = listOf("subrip", "webvtt"),
  )

  @Test
  fun `a declared audio codec is selected in the player`() {
    assertEquals(AudioRoute.Direct, audioRoute(PlaybackMode.Direct, track("aac"), capabilities))
    assertEquals(AudioRoute.Direct, audioRoute(PlaybackMode.Direct, track("eac3"), capabilities))
  }

  @Test
  fun `an undeclared audio codec goes to the server in direct play`() {
    assertEquals(AudioRoute.Server, audioRoute(PlaybackMode.Direct, track("dts"), capabilities))
  }

  @Test
  fun `a converting session sends every audio change to the server`() {
    assertEquals(AudioRoute.Server, audioRoute(PlaybackMode.Remux, track("aac"), capabilities))
    assertEquals(AudioRoute.Server, audioRoute(PlaybackMode.Transcode, track("ac3"), capabilities))
  }

  @Test
  fun `direct play and a declared embedded subtitle selects the track in the player`() {
    assertEquals(SubtitleRoute.EmbeddedDirect, subtitleRoute(PlaybackMode.Direct, track("subrip"), addon = false, capabilities))
  }

  @Test
  fun `direct play but an undeclared embedded subtitle is read by the server`() {
    assertEquals(SubtitleRoute.EmbeddedServer, subtitleRoute(PlaybackMode.Direct, track("mov_text"), addon = false, capabilities))
  }

  @Test
  fun `an embedded subtitle in a converting session is read by the server`() {
    assertEquals(SubtitleRoute.EmbeddedServer, subtitleRoute(PlaybackMode.Remux, track("subrip"), addon = false, capabilities))
    assertEquals(SubtitleRoute.EmbeddedServer, subtitleRoute(PlaybackMode.Transcode, track("webvtt"), addon = false, capabilities))
  }

  @Test
  fun `an addon subtitle is the app's own and a missing one is Off`() {
    assertEquals(SubtitleRoute.Addon, subtitleRoute(PlaybackMode.Direct, track("subrip"), addon = true, capabilities))
    assertEquals(SubtitleRoute.Off, subtitleRoute(PlaybackMode.Direct, null, addon = false, capabilities))
  }

  @Test
  fun `the server is only left out when neither side needs it`() {
    assertFalse(subtitleNeedsServer(currentServer = false, next = SubtitleRoute.EmbeddedDirect))
    assertFalse(subtitleNeedsServer(currentServer = false, next = SubtitleRoute.Off))
    assertFalse(subtitleNeedsServer(currentServer = false, next = SubtitleRoute.Addon))
    assertTrue(subtitleNeedsServer(currentServer = false, next = SubtitleRoute.EmbeddedServer))
    assertTrue(subtitleNeedsServer(currentServer = true, next = SubtitleRoute.EmbeddedDirect))
    assertTrue(subtitleNeedsServer(currentServer = true, next = SubtitleRoute.Addon))
  }

  private fun track(codec: String) = DescriptorTrack(codec = codec)
}
