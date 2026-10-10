package cz.stremiooffline.tv.ui.player

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.playback.DiagPath
import cz.stremiooffline.tv.ui.catalog.SidePanel
import cz.stremiooffline.tv.ui.theme.Tokens

const val TagDiagPanel = "diag_panel"

fun diagRowTag(name: String) = "diag_$name"

/** The panel's own value or the honest dash when the player could not read it. */
internal fun diagValue(value: String?): String = value?.takeIf { it.isNotBlank() } ?: DIAGNOSTIC_UNKNOWN

/**
 * The playback diagnostics panel. Everything it draws comes from the player and the app; a value
 * the device did not report is the dash, never a guess.
 */
@Composable
fun PlayerDiagnosticsPanel(
  path: DiagPath,
  container: String?,
  video: String?,
  hdr: String?,
  audio: String?,
  subtitles: String?,
  bitrate: String?,
  buffer: String?,
  session: String?,
  device: String?,
  converted: Boolean,
  onClose: () -> Unit,
) {
  SidePanel(title = stringResource(R.string.diag_title), onClose = onClose, modifier = Modifier.testTag(TagDiagPanel)) {
    DiagRow("path", stringResource(R.string.tv_diag_path), stringResource(pathLabel(path)), good = path == DiagPath.Direct)
    DiagRow("container", stringResource(R.string.tv_diag_container), diagValue(container))
    DiagRow("video", stringResource(R.string.tv_diag_video), diagValue(video))
    DiagRow("hdr", stringResource(R.string.tv_diag_hdr), diagValue(hdr))
    DiagRow("audio", stringResource(R.string.tv_diag_audio), diagValue(audio))
    DiagRow("subtitles", stringResource(R.string.tv_diag_subtitles), diagValue(subtitles))
    DiagRow("bitrate", stringResource(R.string.tv_diag_bitrate), diagValue(bitrate))
    DiagRow("buffer", stringResource(R.string.tv_diag_buffer), diagValue(buffer))
    DiagRow("session", stringResource(R.string.tv_diag_session), diagValue(session))
    DiagRow("device", stringResource(R.string.tv_diag_device), diagValue(device))
    if (converted) {
      Text(stringResource(R.string.tv_diag_converted), color = Tokens.Muted, fontSize = 11.5.sp, lineHeight = 16.sp)
    }
  }
}

internal fun pathLabel(path: DiagPath): Int = when (path) {
  DiagPath.Direct -> R.string.tv_path_direct
  DiagPath.Audio -> R.string.tv_path_audio
  DiagPath.Remux -> R.string.tv_path_remux
  DiagPath.Transcode -> R.string.tv_path_transcode
}

@Composable
private fun DiagRow(name: String, label: String, value: String, good: Boolean = false) {
  Row(
    modifier = Modifier.fillMaxWidth().testTag(diagRowTag(name)).padding(horizontal = 12.dp, vertical = 5.dp),
    horizontalArrangement = Arrangement.SpaceBetween,
  ) {
    Text(label, color = Tokens.Muted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
    Text(value, color = if (good) Tokens.Green else Tokens.Text, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
  }
}
