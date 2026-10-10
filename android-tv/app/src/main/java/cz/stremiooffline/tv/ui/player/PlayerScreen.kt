@file:OptIn(UnstableApi::class)

package cz.stremiooffline.tv.ui.player

import android.view.ViewGroup
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
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
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.playback.PlaybackController
import cz.stremiooffline.tv.playback.PlaybackMode
import cz.stremiooffline.tv.playback.PlayerTrack
import cz.stremiooffline.tv.playback.PlayerTrackGroup
import cz.stremiooffline.tv.playback.detectCapabilities
import cz.stremiooffline.tv.playback.matchTrack
import cz.stremiooffline.tv.ui.detail.PlayTarget
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

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

  var controls by remember { mutableStateOf(true) }
  var attempt by remember { mutableIntStateOf(0) }
  var loadedUrl by remember { mutableStateOf<String?>(null) }
  var playing by remember { mutableStateOf(false) }
  var position by remember { mutableDoubleStateOf(0.0) }
  // Coming back from the background starts a fresh session paused, at the position left behind.
  var backgroundPosition by remember { mutableStateOf<Double?>(null) }
  var showControls by remember { mutableIntStateOf(0) }
  var startPaused by remember { mutableStateOf(false) }
  // The direct-play audio track is overridden once per descriptor; tracks arrive after the source.
  var audioRevision by remember { mutableIntStateOf(-1) }
  val currentState by rememberUpdatedState(state)

  // The overlay owns focus: a hidden OSD focuses its own root, a shown one the play button.
  val playFocus = remember { FocusRequester() }

  /** The server picked the audio track by the account's language; direct play must follow it. */
  fun applyServerAudio() {
    val snapshot = currentState
    if (snapshot.mode != PlaybackMode.Direct) return
    val hint = snapshot.audioTrack ?: return
    if (audioRevision == snapshot.revision) return
    val tracks = exoPlayer.currentTracks
    val groups = tracks.groups.map { group ->
      PlayerTrackGroup(
        group.type,
        (0 until group.length).map { index ->
          val format = group.getTrackFormat(index)
          PlayerTrack(format.language, format.sampleMimeType, format.channelCount)
        },
      )
    }
    val match = matchTrack(hint, groups, C.TRACK_TYPE_AUDIO) ?: return
    val group = tracks.groups.getOrNull(match.groupIndex) ?: return
    exoPlayer.trackSelectionParameters = exoPlayer.trackSelectionParameters.buildUpon()
      .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, match.trackIndex))
      .build()
    audioRevision = snapshot.revision
  }

  LaunchedEffect(attempt) {
    // A catalogue target already carries the server's source id; a library one is minted from its path.
    val sourceId = target.sourceId ?: target.path?.let { runCatching { api.librarySource(it) }.getOrNull()?.sourceId }
    if (sourceId == null) {
      controller.onNetworkError()
      return@LaunchedEffect
    }
    controller.start(
      sourceId, target.key, target.title, target.path,
      resume = target.resume, poster = target.poster, addonKey = target.addonKey,
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
    applyServerAudio()
  }

  DisposableEffect(exoPlayer) {
    val listener = object : Player.Listener {
      override fun onIsPlayingChanged(isPlaying: Boolean) {
        playing = isPlaying
        if (isPlaying) controller.onPlaying() else controller.onPaused()
      }

      override fun onPlaybackStateChanged(playbackState: Int) {
        if (playbackState == Player.STATE_READY) controller.onPlayerReady()
        if (playbackState == Player.STATE_ENDED) controller.onEnded()
      }

      override fun onTracksChanged(tracks: Tracks) {
        applyServerAudio()
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
      delay(500)
    }
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
          showControls++
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

  val duration = state.duration

  PlayerOverlayShell(
    position = position,
    duration = duration,
    playing = playing,
    title = target.title,
    eyebrow = stringResource(pathLabel(state.mode, state.copyAudio)),
    playFocus = playFocus,
    showControls = showControls,
    seekKept = state.seekKept,
    onSeek = { controller.seekTo(it) },
    onTogglePause = { if (playing) exoPlayer.pause() else exoPlayer.play() },
    onExit = onExit,
    modifier = Modifier.onPreviewKeyEvent { event ->
      if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
      mediaKey(event.key, exoPlayer, playing, onExit) ?: false
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
 * is deliberately absent: the overlay's own rule owns it and hides the controls first. Fast
 * forward and rewind are the overlay's too, so a held key follows the same step rule as the pad.
 */
internal fun mediaKey(key: Key, player: ExoPlayer, playing: Boolean, onExit: () -> Unit): Boolean? = when (key) {
  Key.MediaPlayPause -> { if (playing) player.pause() else player.play(); true }
  Key.MediaPlay -> { player.play(); true }
  Key.MediaPause -> { player.pause(); true }
  else -> null
}

private fun pathLabel(mode: PlaybackMode, copyAudio: Boolean): Int = when (mode) {
  PlaybackMode.Direct -> R.string.tv_path_direct
  PlaybackMode.Transcode -> R.string.tv_path_transcode
  PlaybackMode.Remux -> if (copyAudio) R.string.tv_path_remux else R.string.tv_path_audio
}

private fun isDecoderError(error: PlaybackException): Boolean = error.errorCode in setOf(
  PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
  PlaybackException.ERROR_CODE_DECODER_QUERY_FAILED,
  PlaybackException.ERROR_CODE_DECODING_FAILED,
  PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES,
  PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
)
