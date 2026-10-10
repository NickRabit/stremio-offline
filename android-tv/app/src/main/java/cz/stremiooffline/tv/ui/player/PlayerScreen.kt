@file:OptIn(UnstableApi::class)

package cz.stremiooffline.tv.ui.player

import android.os.Build
import android.view.ViewGroup
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.ui.PlayerView
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.AddonSubtitleDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.playback.NextEpisode
import cz.stremiooffline.tv.playback.PlaybackController
import cz.stremiooffline.tv.playback.PlaybackDiagnostics
import cz.stremiooffline.tv.playback.PlaybackMode
import cz.stremiooffline.tv.playback.PlayerTrack
import cz.stremiooffline.tv.playback.PlayerTrackGroup
import cz.stremiooffline.tv.playback.Progress
import cz.stremiooffline.tv.playback.SidecarState
import cz.stremiooffline.tv.playback.SubtitleChoice
import cz.stremiooffline.tv.playback.SubtitleDelay
import cz.stremiooffline.tv.playback.VttCue
import cz.stremiooffline.tv.playback.detectCapabilities
import cz.stremiooffline.tv.playback.diagPath
import cz.stremiooffline.tv.playback.matchTrack
import cz.stremiooffline.tv.playback.nextEpisodeOf
import cz.stremiooffline.tv.playback.parseVtt
import cz.stremiooffline.tv.playback.sidecarAdvanced
import cz.stremiooffline.tv.playback.sidecarPollDelay
import cz.stremiooffline.tv.playback.sidecarRefresh
import cz.stremiooffline.tv.ui.detail.PlayTarget
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

@Composable
fun PlayerScreen(api: TvApi, target: PlayTarget, onExit: () -> Unit) {
  val context = LocalContext.current
  val lifecycle = LocalLifecycleOwner.current.lifecycle
  val capabilities = remember { detectCapabilities(context) }
  // The teardown save and delete must outlive the composition, so the controller gets its own
  // scope rather than the one Compose cancels on dispose.
  val scope = remember { CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate) }
  val controller = remember(api) { PlaybackController(api, scope, System::currentTimeMillis, capabilities) }
  val state by controller.state.collectAsStateWithLifecycle()

  val exoPlayer = remember(api) {
    ExoPlayer.Builder(context)
      .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(api.http)))
      .build()
  }
  val mediaSession = remember(exoPlayer) { MediaSession.Builder(context, exoPlayer).build() }

  var attempt by remember { mutableIntStateOf(0) }
  var loadedUrl by remember { mutableStateOf<String?>(null) }
  var playing by remember { mutableStateOf(false) }
  var position by remember { mutableDoubleStateOf(0.0) }
  // Coming back from the background starts a fresh session paused, at the position left behind.
  var backgroundPosition by remember { mutableStateOf<Double?>(null) }
  var startPaused by remember { mutableStateOf(false) }
  var activeSourceId by remember { mutableStateOf<String?>(null) }
  var settings by remember { mutableStateOf(SettingsResponse()) }
  var addonSubtitles by remember { mutableStateOf<List<AddonSubtitleDto>>(emptyList()) }
  var addonFetched by remember { mutableStateOf(false) }

  var tracksOpen by remember { mutableStateOf(false) }
  var diagnosticsOpen by remember { mutableStateOf(false) }
  // The button that opened a panel takes the remote back once the panel and its focus trap are
  // gone; the request waits for the frame that removed them.
  var restoreFocus by remember { mutableStateOf<FocusRequester?>(null) }
  var nextEpisode by remember { mutableStateOf<NextEpisode?>(null) }
  var nextCard by remember { mutableStateOf(false) }
  // The correction lives with this playback, not beyond it.
  var delaySeconds by remember(target.key) { mutableDoubleStateOf(0.0) }
  var cues by remember { mutableStateOf<List<VttCue>>(emptyList()) }

  val currentState by rememberUpdatedState(state)
  val currentNext by rememberUpdatedState(nextEpisode)

  val tracksFocus = remember { FocusRequester() }
  val tracksEntry = remember { FocusRequester() }
  val diagnosticsFocus = remember { FocusRequester() }
  val playFocus = remember { FocusRequester() }
  val nextFocus = remember { FocusRequester() }

  LaunchedEffect(restoreFocus) {
    val target = restoreFocus ?: return@LaunchedEffect
    restoreFocus = null
    runCatching { target.requestFocus() }
  }

  /** The player's tracks, grouped the way the player groups them, for the matcher. */
  fun offeredTracks(): List<PlayerTrackGroup> = exoPlayer.currentTracks.groups.map { group ->
    PlayerTrackGroup(
      group.type,
      (0 until group.length).map { index ->
        val format = group.getTrackFormat(index)
        PlayerTrack(format.language, format.sampleMimeType, format.channelCount)
      },
    )
  }

  /**
   * The audio choice is selected in ExoPlayer only in direct play; a converted stream carries the
   * chosen track itself. A text track the client draws is selected here, and every other subtitle
   * source (Off, addon, server sidecar) turns ExoPlayer's own text renderer off.
   */
  fun applyTracks() {
    val snapshot = currentState
    if (!snapshot.started || snapshot.url == null) return
    val groups = offeredTracks()
    val builder = exoPlayer.trackSelectionParameters.buildUpon()

    val audioMatch = if (snapshot.mode == PlaybackMode.Direct) snapshot.audioTrack?.let { matchTrack(it, groups, C.TRACK_TYPE_AUDIO) } else null
    if (audioMatch != null) {
      val mediaGroup = exoPlayer.currentTracks.groups[audioMatch.groupIndex].mediaTrackGroup
      builder.setOverrideForType(TrackSelectionOverride(mediaGroup, audioMatch.trackIndex))
    } else {
      builder.clearOverridesOfType(C.TRACK_TYPE_AUDIO)
    }

    val embedded = snapshot.subtitle as? SubtitleChoice.Embedded
    val textDirect = snapshot.mode == PlaybackMode.Direct && embedded != null && snapshot.sidecarUrl == null
    val textMatch = if (textDirect) snapshot.subtitleTracks.getOrNull(embedded!!.index)?.let { matchTrack(it, groups, C.TRACK_TYPE_TEXT) } else null
    if (textMatch != null) {
      val mediaGroup = exoPlayer.currentTracks.groups[textMatch.groupIndex].mediaTrackGroup
      builder.setOverrideForType(TrackSelectionOverride(mediaGroup, textMatch.trackIndex))
      builder.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
    } else {
      builder.clearOverridesOfType(C.TRACK_TYPE_TEXT)
      builder.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
    }

    val desired = builder.build()
    if (exoPlayer.trackSelectionParameters != desired) exoPlayer.trackSelectionParameters = desired
  }

  fun startNext() {
    val next = currentNext ?: return
    nextCard = false
    delaySeconds = 0.0
    cues = emptyList()
    scope.launch {
      val source = runCatching { api.librarySource(next.path) }.getOrNull() ?: return@launch
      activeSourceId = source.sourceId
      controller.playNext(
        sourceId = source.sourceId,
        key = Progress.libraryKey(next.path),
        title = next.title,
        path = next.path,
        resume = false,
      )
    }
  }

  // A new title left nothing behind: the cached list, the offer and the delay belong to one playback.
  LaunchedEffect(target.key) {
    addonFetched = false
    addonSubtitles = emptyList()
    nextEpisode = null
    nextCard = false
    tracksOpen = false
    diagnosticsOpen = false
    cues = emptyList()
  }

  LaunchedEffect(attempt) {
    // A catalogue target already carries the server's source id; a library one is minted from its path.
    val sourceId = target.sourceId ?: target.path?.let { runCatching { api.librarySource(it) }.getOrNull()?.sourceId }
    if (sourceId == null) {
      controller.onNetworkError()
      return@LaunchedEffect
    }
    activeSourceId = sourceId
    // The account's languages and the addon subtitles are read just before the start: the ids are
    // minted per sign-in session and are short-lived, so they cannot be fetched any earlier.
    if (!addonFetched) {
      addonFetched = true
      settings = runCatching { api.settings() }.getOrDefault(SettingsResponse())
      val type = target.subtitleType
      val id = target.subtitleTarget
      if (type != null && id != null) addonSubtitles = runCatching { api.subtitles(type, id) }.getOrDefault(emptyList())
    }
    controller.start(
      sourceId = sourceId,
      key = target.key,
      title = target.title,
      path = target.path,
      resume = target.resume,
      poster = target.poster,
      addonKey = target.addonKey,
      subtitles = addonSubtitles,
      audioPreference = settings.audioLanguage,
      subtitlePreference = settings.subtitleLanguage,
    )
  }

  LaunchedEffect(state.revision) {
    val url = state.url?.let(api::url) ?: return@LaunchedEffect
    if (url != loadedUrl) {
      loadedUrl = url
      if (state.playlist) {
        val factory = OkHttpDataSource.Factory(api.http)
        exoPlayer.setMediaSource(
          HlsMediaSource.Factory(factory).setAllowChunklessPreparation(true).createMediaSource(MediaItem.fromUri(url))
        )
      } else {
        exoPlayer.setMediaItem(MediaItem.fromUri(url))
      }
      exoPlayer.prepare()
    }
    exoPlayer.seekTo(((state.target - state.offset).coerceAtLeast(0.0) * 1000).toLong())
    exoPlayer.playWhenReady = !startPaused
    startPaused = false
    applyTracks()
  }

  LaunchedEffect(state.trackRevision) {
    applyTracks()
  }

  DisposableEffect(exoPlayer) {
    val listener = object : Player.Listener {
      override fun onIsPlayingChanged(isPlaying: Boolean) {
        playing = isPlaying
        if (isPlaying) controller.onPlaying() else controller.onPaused()
      }

      override fun onPlaybackStateChanged(playbackState: Int) {
        if (playbackState == Player.STATE_READY) controller.onPlayerReady()
        if (playbackState == Player.STATE_ENDED) {
          controller.onEnded()
          if (currentNext != null) nextCard = true
        }
      }

      override fun onTracksChanged(tracks: Tracks) {
        applyTracks()
      }

      override fun onPlayerError(error: PlaybackException) {
        if (isDecoderError(error)) controller.onDecoderError() else controller.onNetworkError()
      }
    }
    exoPlayer.addListener(listener)
    onDispose { exoPlayer.removeListener(listener) }
  }

  LaunchedEffect(exoPlayer) {
    while (isActive) {
      controller.onPlayerPosition(exoPlayer.currentPosition / 1000.0)
      position = controller.position
      delay(250)
    }
  }

  // The next library file is resolved once the session is up, so the offer is ready at the end.
  LaunchedEffect(state.started, state.startedAt, activeSourceId, target.path) {
    if (!state.started || target.path == null) return@LaunchedEffect
    val id = activeSourceId ?: return@LaunchedEffect
    nextEpisode = runCatching { api.libraryNext(id) }.getOrNull()?.let(::nextEpisodeOf)
  }

  val sidecar = state.sidecarUrl
  val embeddedChoice = state.subtitle as? SubtitleChoice.Embedded
  val addonChoice = state.subtitle as? SubtitleChoice.Addon
  val sidecarActive = sidecar != null && embeddedChoice != null
  val resolvedAddonId = addonChoice?.let { state.subtitleIds[it.subtitleId] ?: it.subtitleId }

  // The sidecar is polled the way the web watches it; a 404 only means "come back".
  LaunchedEffect(sidecarActive, sidecar, delaySeconds) {
    if (sidecar == null || embeddedChoice == null) return@LaunchedEffect
    var watcher = SidecarState()
    cues = emptyList()
    while (isActive) {
      val at = controller.position
      val fetch = runCatching { api.sidecar(sidecar, at, delaySeconds) }.getOrNull()
      if (fetch != null) {
        if (sidecarRefresh(watcher, fetch.coverage, fetch.complete, at)) {
          cues = parseVtt(fetch.text)
          watcher = sidecarAdvanced(watcher, fetch.coverage, fetch.complete)
        }
        if (fetch.complete) return@LaunchedEffect
      }
      delay(sidecarPollDelay(watcher, controller.position))
    }
  }

  // An addon subtitle is read once, and again whenever the delay moves it.
  LaunchedEffect(addonChoice, resolvedAddonId, delaySeconds, state.offset) {
    if (addonChoice == null || resolvedAddonId == null) return@LaunchedEffect
    cues = emptyList()
    val text = runCatching { api.subtitleText(resolvedAddonId, state.offset, delaySeconds) }.getOrNull() ?: return@LaunchedEffect
    cues = parseVtt(text)
  }

  LaunchedEffect(state.trackRevision) {
    if (!sidecarActive && addonChoice == null) cues = emptyList()
  }

  DisposableEffect(lifecycle) {
    val observer = LifecycleEventObserver { _, event ->
      when (event) {
        Lifecycle.Event.ON_STOP -> {
          exoPlayer.pause()
          backgroundPosition = controller.position
          // The session is gone, so even an unchanged address must be prepared again.
          loadedUrl = null
          controller.stop()
        }
        Lifecycle.Event.ON_START -> {
          if (backgroundPosition == null) return@LifecycleEventObserver
          backgroundPosition = null
          startPaused = true
          nextCard = false
          controller.retry()
        }
        else -> Unit
      }
    }
    lifecycle.addObserver(observer)
    onDispose { lifecycle.removeObserver(observer) }
  }

  DisposableEffect(Unit) {
    onDispose {
      controller.stop()
      mediaSession.release()
      exoPlayer.release()
    }
  }

  val delayEnabled = sidecarActive || addonChoice != null
  val videoFormat = exoPlayer.videoFormat
  val audioFormat = exoPlayer.audioFormat
  val passthrough = state.mode == PlaybackMode.Direct && state.audioTrack?.codec?.let { it in capabilities.audioPassthrough } == true
  val audioValue = listOfNotNull(
    audioFormat?.sampleMimeType ?: state.audioCodec,
    stringResource(R.string.tv_audio_passthrough).takeIf { passthrough },
  ).joinToString(" · ").ifBlank { null }
  val sessionValue = state.lastPingAt?.let { at ->
    val seconds = ((System.currentTimeMillis() - at) / 1000).coerceAtLeast(0)
    if (seconds < 1) stringResource(R.string.diag_just_now) else stringResource(R.string.tv_diag_ping, seconds.toString())
  }
  val device = remember { "${Build.MODEL} · Android ${Build.VERSION.RELEASE}" }
  val addonName = addonChoice?.let { picked -> state.addonSubtitles.firstOrNull { it.subtitleId == picked.subtitleId }?.addonName }
  val subtitleSourceLabel = when {
    !addonName.isNullOrBlank() -> addonName
    addonChoice != null -> stringResource(R.string.player_from_addon)
    state.subtitle == SubtitleChoice.Off -> stringResource(R.string.player_subtitles_off)
    else -> stringResource(R.string.tv_subtitle_embedded)
  }

  PlayerOverlayShell(
    position = position,
    duration = state.duration,
    playing = playing,
    title = target.title,
    eyebrow = stringResource(pathLabel(diagPath(state.mode, state.copyAudio))),
    playFocus = playFocus,
    seekKept = state.seekKept,
    modal = tracksOpen || diagnosticsOpen || nextCard,
    onSeek = { controller.seekTo(it) },
    onTogglePause = { if (playing) exoPlayer.pause() else exoPlayer.play() },
    onExit = onExit,
    onTracks = { tracksOpen = true },
    tracksText = tracksButtonText(state.audioTrack?.language),
    tracksLabel = stringResource(R.string.tv_tracks_title),
    tracksFocus = tracksFocus,
    onNext = if (currentNext != null) ({ startNext() }) else null,
    nextLabel = stringResource(R.string.player_next_episode),
    onDiagnostics = { diagnosticsOpen = true },
    diagnosticsLabel = stringResource(R.string.diag_title),
    diagnosticsFocus = diagnosticsFocus,
    modifier = Modifier.onPreviewKeyEvent { event ->
      if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
      mediaKey(event.key, exoPlayer, playing, onExit) ?: false
    },
    topLayer = {
      if (tracksOpen) {
        PlayerTracksPanel(
          audioTracks = state.audioTracks,
          audioTrackIndex = state.audioTrackIndex,
          subtitleTracks = state.subtitleTracks,
          subtitle = state.subtitle,
          addonSubtitles = state.addonSubtitles,
          capabilities = capabilities,
          delay = delaySeconds,
          delayEnabled = delayEnabled,
          onAudio = { controller.selectAudio(it) },
          onSubtitle = { controller.selectSubtitle(it) },
          onDelay = { delaySeconds = SubtitleDelay.nudge(delaySeconds, it) },
          onClose = {
            tracksOpen = false
            restoreFocus = tracksFocus
          },
          initialFocus = tracksEntry,
        )
      }

      if (diagnosticsOpen) {
        PlayerDiagnosticsPanel(
          path = diagPath(state.mode, state.copyAudio),
          container = null,
          video = PlaybackDiagnostics.video(
            codec = videoFormat?.sampleMimeType,
            width = videoFormat?.width?.takeIf { it > 0 },
            height = videoFormat?.height?.takeIf { it > 0 },
            frameRate = videoFormat?.frameRate?.takeIf { it > 0 },
            codecs = videoFormat?.codecs,
          ),
          hdr = PlaybackDiagnostics.color(videoFormat?.colorInfo),
          audio = audioValue,
          subtitles = subtitleSourceLabel,
          bitrate = PlaybackDiagnostics.bitrate(videoFormat?.bitrate),
          buffer = PlaybackDiagnostics.buffer(exoPlayer.totalBufferedDuration),
          session = sessionValue,
          device = device,
          converted = state.mode != PlaybackMode.Direct,
          onClose = {
            diagnosticsOpen = false
            restoreFocus = diagnosticsFocus
          },
        )
      }

      if (nextCard && currentNext != null) {
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.35f)), contentAlignment = Alignment.BottomEnd) {
          Box(Modifier.padding(48.dp)) {
            NextEpisodeOffer(
              title = currentNext!!.title,
              onPlay = { startNext() },
              onDismiss = {
                nextCard = false
                restoreFocus = playFocus
              },
              focus = nextFocus,
            )
          }
        }
      }
    },
  ) {
    AndroidView(
      factory = { ctx ->
        PlayerView(ctx).apply {
          useController = false
          player = exoPlayer
          isFocusable = false
          isFocusableInTouchMode = false
          descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
        }
      },
      modifier = Modifier.fillMaxSize(),
    )

    if (cues.isNotEmpty()) SubtitleOverlay(cues = cues, position = position)

    when {
      state.error != null -> ErrorPanel(
        onRetry = { if (state.started) controller.retry() else attempt++ },
        onBack = onExit,
      )
      !state.started -> LoadingOverlay(title = target.title)
    }
  }
}

/**
 * The media keys work whether or not the OSD is up; a null answer means the key is not ours. Back
 * is deliberately absent: the overlay's own rule owns it and hides the controls first.
 */
internal fun mediaKey(key: Key, player: ExoPlayer, playing: Boolean, onExit: () -> Unit): Boolean? = when (key) {
  Key.MediaPlayPause -> { if (playing) player.pause() else player.play(); true }
  Key.MediaPlay -> { player.play(); true }
  Key.MediaPause -> { player.pause(); true }
  else -> null
}

private fun isDecoderError(error: PlaybackException): Boolean = error.errorCode in setOf(
  PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
  PlaybackException.ERROR_CODE_DECODER_QUERY_FAILED,
  PlaybackException.ERROR_CODE_DECODING_FAILED,
  PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES,
  PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
)
