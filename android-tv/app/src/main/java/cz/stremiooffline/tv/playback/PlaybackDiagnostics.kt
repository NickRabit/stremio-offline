@file:OptIn(UnstableApi::class)

package cz.stremiooffline.tv.playback

import androidx.media3.common.C
import androidx.media3.common.ColorInfo
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import java.util.Locale

/** Which of the four paths the session is on, read off `mode` and `copy.audio`. */
enum class DiagPath { Direct, Audio, Remux, Transcode }

fun diagPath(mode: PlaybackMode, copyAudio: Boolean): DiagPath = when (mode) {
  PlaybackMode.Direct -> DiagPath.Direct
  PlaybackMode.Transcode -> DiagPath.Transcode
  PlaybackMode.Remux -> if (copyAudio) DiagPath.Remux else DiagPath.Audio
}

/** The values the diagnostics panel reads from the player. Every one may be missing, and a
 *  missing value is what the panel draws as `—` instead of inventing one. */
object PlaybackDiagnostics {

  fun video(codec: String?, width: Int?, height: Int?, frameRate: Float?, codecs: String?): String? {
    val parts = listOfNotNull(codec, resolution(width, height), frameRate(frameRate), codecs)
      .map { it.trim() }
      .filter { it.isNotEmpty() }
    return parts.takeIf { it.isNotEmpty() }?.joinToString(" · ")
  }

  fun resolution(width: Int?, height: Int?): String? =
    if (width != null && height != null && width > 0 && height > 0) "${width}×${height}" else null

  fun frameRate(value: Float?): String? {
    if (value == null || value <= 0f || !value.isFinite()) return null
    return String.format(Locale.US, "%.3f", value).trimEnd('0').trimEnd('.')
  }

  fun bitrate(value: Int?): String? =
    if (value != null && value > 0) String.format(Locale.US, "%.1f Mb/s", value / 1_000_000.0) else null

  fun buffer(millis: Long?): String? =
    if (millis != null && millis >= 0) String.format(Locale.US, "%.0f s", millis / 1000.0) else null

  /** The video format's colour information as the decoder reported it, or null when it said nothing. */
  fun color(colorInfo: ColorInfo?): String? {
    val color = colorInfo ?: return null
    val parts = buildList {
      colorSpace(color.colorSpace)?.let(::add)
      transfer(color.colorTransfer)?.let(::add)
      if (color.lumaBitdepth > 0) add("${color.lumaBitdepth}-bit")
    }
    return parts.takeIf { it.isNotEmpty() }?.joinToString(" · ")
  }

  private fun colorSpace(value: Int): String? = when (value) {
    C.COLOR_SPACE_BT709 -> "BT.709"
    C.COLOR_SPACE_BT2020 -> "BT.2020"
    C.COLOR_SPACE_BT601 -> "BT.601"
    else -> null
  }

  private fun transfer(value: Int): String? = when (value) {
    C.COLOR_TRANSFER_ST2084 -> "HDR10"
    C.COLOR_TRANSFER_HLG -> "HLG"
    C.COLOR_TRANSFER_SDR -> "SDR"
    C.COLOR_TRANSFER_GAMMA_2_2 -> "Gamma 2.2"
    C.COLOR_TRANSFER_LINEAR -> "Linear"
    else -> null
  }
}
