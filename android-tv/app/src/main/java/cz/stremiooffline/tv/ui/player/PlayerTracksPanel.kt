package cz.stremiooffline.tv.ui.player

import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.catalog.Languages
import cz.stremiooffline.tv.data.AddonSubtitleDto
import cz.stremiooffline.tv.data.ClientCapabilitiesDto
import cz.stremiooffline.tv.playback.DescriptorTrack
import cz.stremiooffline.tv.playback.SubtitleChoice
import cz.stremiooffline.tv.playback.SubtitleDelay
import cz.stremiooffline.tv.ui.catalog.PanelOption
import cz.stremiooffline.tv.ui.catalog.SidePanel
import cz.stremiooffline.tv.ui.theme.Tokens

const val TagTracksPanel = "tracks_panel"
const val TagDelayRow = "tracks_delay"
fun audioRowTag(index: Int) = "tracks_audio_$index"
fun embeddedRowTag(index: Int) = "tracks_sub_e$index"
fun addonRowTag(index: Int) = "tracks_sub_a$index"
const val TagSubtitleOffRow = "tracks_sub_off"

/** The panel's "no value" mark, drawn wherever a value could not be read. */
const val DIAGNOSTIC_UNKNOWN = "—"

/** The row the panel hands the remote to when it opens: the one the viewer is using now. */
internal sealed interface TracksEntry {
  data class Audio(val index: Int) : TracksEntry
  data object Off : TracksEntry
  data class Embedded(val index: Int) : TracksEntry
  data class Addon(val index: Int) : TracksEntry
}

/**
 * Which row takes focus on open. A title with no audio still has the Off row, so the panel never
 * opens without a focusable target -- an unfocused panel left the D-pad dead.
 */
internal fun tracksEntry(
  audioTracks: List<DescriptorTrack>,
  audioTrackIndex: Int,
  subtitleTracks: List<DescriptorTrack>,
  subtitle: SubtitleChoice,
  addonSubtitles: List<AddonSubtitleDto>,
): TracksEntry = when {
  audioTracks.isNotEmpty() -> TracksEntry.Audio(audioTrackIndex.coerceIn(0, audioTracks.lastIndex))
  subtitle is SubtitleChoice.Embedded && subtitle.index in subtitleTracks.indices -> TracksEntry.Embedded(subtitle.index)
  subtitle is SubtitleChoice.Addon -> {
    val index = addonSubtitles.indexOfFirst { it.subtitleId == subtitle.subtitleId }
    if (index >= 0) TracksEntry.Addon(index) else TracksEntry.Off
  }
  else -> TracksEntry.Off
}

/**
 * The addon rows' labels. Several releases of one film in one language arrive with the same
 * language and addon name, so only the shared ones are numbered -- that is what tells them apart.
 */
internal fun addonSubtitleLabels(addonSubtitles: List<AddonSubtitleDto>): List<String> {
  val bases = addonSubtitles.map { item ->
    val parts = mutableListOf(Languages.label(item.lang))
    item.addonName?.takeIf { it.isNotBlank() }?.let(parts::add)
    parts.joinToString(" · ")
  }
  val totals = bases.groupingBy { it }.eachCount()
  val seen = mutableMapOf<String, Int>()
  return bases.map { base ->
    if ((totals[base] ?: 0) > 1) "$base · ${seen.merge(base, 1, Int::plus)}" else base
  }
}

/** The channel name the web shows beside a codec, or `3ch`. */
internal fun channelLabel(channels: Int): String? = when {
  channels <= 0 -> null
  channels == 1 -> "mono"
  channels == 2 -> "stereo"
  channels == 6 -> "5.1"
  channels == 8 -> "7.1"
  else -> "${channels}ch"
}

/** The three ways one audio track can reach the viewer, by the declared capabilities. */
internal fun audioCapabilityLabel(track: DescriptorTrack, capabilities: ClientCapabilitiesDto): Int {
  val codec = track.codec
  return when {
    codec != null && codec in capabilities.audioPassthrough -> R.string.tv_audio_passthrough
    codec != null && codec in capabilities.audioDecode -> R.string.tv_audio_decoded
    else -> R.string.tv_audio_converted
  }
}

/** `label(language) · title · codec · channels · capability`, the panel's audio row. */
@Composable
internal fun audioRowLabel(track: DescriptorTrack, capabilities: ClientCapabilitiesDto): String {
  val parts = mutableListOf(Languages.label(track.language))
  track.title?.takeIf { it.isNotBlank() }?.let(parts::add)
  track.codec?.takeIf { it.isNotBlank() }?.let(parts::add)
  channelLabel(track.channels)?.let(parts::add)
  return parts.joinToString(" · ") + " · " + stringResource(audioCapabilityLabel(track, capabilities))
}

/** `label(language) · title · forced · source`, the panel's embedded subtitle row. */
@Composable
internal fun embeddedRowLabel(track: DescriptorTrack): String {
  val parts = mutableListOf(Languages.label(track.language))
  track.title?.takeIf { it.isNotBlank() }?.let(parts::add)
  if (track.forced) parts.add(stringResource(R.string.tv_subtitle_forced))
  parts.add(stringResource(R.string.tv_subtitle_embedded))
  return parts.joinToString(" · ")
}

/**
 * The Audio and subtitles panel. The ticked rows are re-derived from the answered descriptor by
 * the caller; this only draws them and reports a press.
 */
@Composable
fun PlayerTracksPanel(
  audioTracks: List<DescriptorTrack>,
  audioTrackIndex: Int,
  subtitleTracks: List<DescriptorTrack>,
  subtitle: SubtitleChoice,
  addonSubtitles: List<AddonSubtitleDto>,
  capabilities: ClientCapabilitiesDto,
  delay: Double,
  delayEnabled: Boolean,
  onAudio: (Int) -> Unit,
  onSubtitle: (SubtitleChoice) -> Unit,
  onDelay: (Double) -> Unit,
  onClose: () -> Unit,
  initialFocus: FocusRequester? = null,
) {
  val entry = tracksEntry(audioTracks, audioTrackIndex, subtitleTracks, subtitle, addonSubtitles)
  val addonLabels = addonSubtitleLabels(addonSubtitles)
  SidePanel(
    title = stringResource(R.string.tv_tracks_title),
    onClose = onClose,
    modifier = Modifier.testTag(TagTracksPanel),
    initialFocus = initialFocus,
  ) {
    Text(stringResource(R.string.tv_audio_section), color = Tokens.Muted, fontSize = 12.sp, fontWeight = FontWeight.Bold)
    if (audioTracks.isEmpty()) {
      Text(DIAGNOSTIC_UNKNOWN, color = Tokens.Muted, fontSize = 13.sp)
    } else {
      audioTracks.forEachIndexed { index, track ->
        PanelOption(
          text = audioRowLabel(track, capabilities),
          selected = index == audioTrackIndex,
          onClick = { onAudio(index) },
          modifier = Modifier
            .testTag(audioRowTag(index))
            .then(if (initialFocus != null && entry == TracksEntry.Audio(index)) Modifier.focusRequester(initialFocus) else Modifier),
        )
      }
    }

    Text(stringResource(R.string.player_subtitles), color = Tokens.Muted, fontSize = 12.sp, fontWeight = FontWeight.Bold)
    PanelOption(
      text = stringResource(R.string.player_subtitles_off),
      selected = subtitle == SubtitleChoice.Off,
      onClick = { onSubtitle(SubtitleChoice.Off) },
      modifier = Modifier
        .testTag(TagSubtitleOffRow)
        .then(if (initialFocus != null && entry == TracksEntry.Off) Modifier.focusRequester(initialFocus) else Modifier),
    )
    subtitleTracks.forEachIndexed { index, track ->
      PanelOption(
        text = embeddedRowLabel(track),
        selected = subtitle == SubtitleChoice.Embedded(index),
        onClick = { onSubtitle(SubtitleChoice.Embedded(index)) },
        modifier = Modifier
          .testTag(embeddedRowTag(index))
          .then(if (initialFocus != null && entry == TracksEntry.Embedded(index)) Modifier.focusRequester(initialFocus) else Modifier),
      )
    }
    addonSubtitles.forEachIndexed { index, item ->
      PanelOption(
        text = addonLabels[index],
        selected = subtitle == SubtitleChoice.Addon(item.subtitleId),
        onClick = { onSubtitle(SubtitleChoice.Addon(item.subtitleId)) },
        modifier = Modifier
          .testTag(addonRowTag(index))
          .then(if (initialFocus != null && entry == TracksEntry.Addon(index)) Modifier.focusRequester(initialFocus) else Modifier),
      )
    }

    DelayRow(delay = delay, enabled = delayEnabled, onDelay = onDelay)
  }
}

/** The delay row: LEFT/RIGHT change it by a quarter of a second, and it is disabled while only
 *  an embedded track the client draws itself is playing. */
@Composable
private fun DelayRow(delay: Double, enabled: Boolean, onDelay: (Double) -> Unit) {
  var focused by remember { mutableStateOf(false) }
  val label = stringResource(R.string.player_subtitle_delay)
  val disabled = stringResource(R.string.tv_delay_embedded)
  val value = if (delay == 0.0) stringResource(R.string.player_subtitle_in_step) else SubtitleDelay.format(delay)
  Row(
    modifier = Modifier
      .fillMaxWidth()
      .testTag(TagDelayRow)
      .focusable(enabled)
      .onFocusChanged { focused = it.isFocused }
      .onPreviewKeyEvent { event ->
        if (!enabled || event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
        when (event.key) {
          Key.DirectionLeft -> { onDelay(-SubtitleDelay.STEP_S); true }
          Key.DirectionRight -> { onDelay(SubtitleDelay.STEP_S); true }
          else -> false
        }
      }
      .then(if (focused && enabled) Modifier.background(Tokens.Panel2, RoundedCornerShape(8.dp)) else Modifier)
      .padding(horizontal = 12.dp, vertical = 10.dp),
    horizontalArrangement = Arrangement.SpaceBetween,
  ) {
    Text(
      label,
      color = if (enabled) Tokens.Text else Tokens.Muted,
      fontSize = 13.sp,
      fontWeight = FontWeight.SemiBold,
      modifier = Modifier
        .semantics { contentDescription = if (enabled) "$label $value" else disabled }
        .weight(1f),
    )
    Text(
      if (enabled) value else disabled,
      color = if (enabled) Tokens.Accent else Tokens.Muted,
      fontSize = 13.sp,
      fontWeight = FontWeight.Bold,
    )
  }
}
