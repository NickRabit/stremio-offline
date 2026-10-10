package cz.stremiooffline.tv.playback

import android.media.MediaCodecInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CapabilitiesTest {

  @Test
  fun `a shield-like device reports the deep codecs and the passthrough audio`() {
    val avcHigh = MediaCodecInfo.CodecProfileLevel.AVCProfileHigh
    val hevcMain10 = MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10
    val vp9Profile2 = MediaCodecInfo.CodecProfileLevel.VP9Profile2
    val codecs = listOf(
      CodecInfo("video/avc", false, listOf(avcHigh)),
      CodecInfo("video/hevc", false, listOf(hevcMain10)),
      CodecInfo("video/x-vnd.on2.vp9", false, listOf(vp9Profile2)),
      CodecInfo("audio/ac3", false, emptyList()),
      CodecInfo("audio/eac3", false, emptyList()),
      // An encoder is not a decoder and must not appear in the answer.
      CodecInfo("video/avc", true, listOf(avcHigh)),
    )

    val capabilities = capabilitiesFrom(codecs, setOf("dts", "truehd"))

    assertTrue(capabilities.h264)
    assertTrue(capabilities.hevc)
    assertTrue(capabilities.hevc10)
    assertTrue(capabilities.vp9)
    assertFalse(capabilities.av1)
    assertTrue(capabilities.ac3)
    assertTrue(capabilities.eac3)
    assertEquals(listOf("hevc", "vp9"), capabilities.deepColor)
    assertEquals(listOf("ac3", "eac3"), capabilities.audioDecode)
    assertEquals(listOf("dts", "truehd"), capabilities.audioPassthrough)
    assertEquals(listOf("mp4", "mkv", "webm", "ts"), capabilities.containers)
    assertEquals(listOf("subrip", "ass", "webvtt", "hdmv_pgs_subtitle"), capabilities.subtitles)
  }

  @Test
  fun `a minimal device decodes h264 and aac only`() {
    val codecs = listOf(
      CodecInfo("video/avc", false, emptyList()),
      CodecInfo("audio/mp4a-latm", false, emptyList()),
    )

    val capabilities = capabilitiesFrom(codecs, emptySet())

    assertTrue(capabilities.h264)
    assertTrue(capabilities.aac)
    assertFalse(capabilities.hevc)
    assertTrue(capabilities.deepColor.isEmpty())
  }
}
