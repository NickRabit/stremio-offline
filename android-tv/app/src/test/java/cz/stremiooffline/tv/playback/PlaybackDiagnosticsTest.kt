@file:OptIn(androidx.media3.common.util.UnstableApi::class)

package cz.stremiooffline.tv.playback

import androidx.media3.common.C
import androidx.media3.common.ColorInfo
import androidx.media3.common.util.UnstableApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PlaybackDiagnosticsTest {

  private fun info(
    colorSpace: Int = -1,
    colorTransfer: Int = -1,
    lumaBitdepth: Int = -1,
  ) = ColorInfo.Builder()
    .setColorSpace(colorSpace)
    .setColorTransfer(colorTransfer)
    .setLumaBitdepth(lumaBitdepth)
    .build()

  @Test
  fun `the path names the conversion the server is doing`() {
    assertEquals(DiagPath.Direct, diagPath(PlaybackMode.Direct, copyAudio = true))
    assertEquals(DiagPath.Remux, diagPath(PlaybackMode.Remux, copyAudio = true))
    assertEquals(DiagPath.Audio, diagPath(PlaybackMode.Remux, copyAudio = false))
    assertEquals(DiagPath.Transcode, diagPath(PlaybackMode.Transcode, copyAudio = true))
  }

  @Test
  fun `the video row holds what the player reported and nothing more`() {
    assertEquals("video/avc · 1920×1080 · 23.976 · avc1.64001f", PlaybackDiagnostics.video("video/avc", 1920, 1080, 23.976f, "avc1.64001f"))
    assertNull(PlaybackDiagnostics.video(null, null, null, null, null))
    assertNull(PlaybackDiagnostics.resolution(0, 0))
    assertEquals("25", PlaybackDiagnostics.frameRate(25.0f))
    assertNull(PlaybackDiagnostics.frameRate(0f))
  }

  @Test
  fun `bitrate and buffer are only shown when they are real`() {
    assertEquals("8.0 Mb/s", PlaybackDiagnostics.bitrate(8_000_000))
    assertNull(PlaybackDiagnostics.bitrate(-1))
    assertNull(PlaybackDiagnostics.bitrate(null))
    assertEquals("24 s", PlaybackDiagnostics.buffer(24_400))
    assertNull(PlaybackDiagnostics.buffer(null))
  }

  @Test
  fun `HDR comes from the colour information the decoder reported`() {
    assertEquals("BT.2020 · HDR10 · 10-bit", PlaybackDiagnostics.color(info(C.COLOR_SPACE_BT2020, C.COLOR_TRANSFER_ST2084, 10)))
    assertEquals("HLG", PlaybackDiagnostics.color(info(colorTransfer = C.COLOR_TRANSFER_HLG)))
    assertNull(PlaybackDiagnostics.color(null))
    assertNull(PlaybackDiagnostics.color(info()))
  }
}
