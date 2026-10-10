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
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
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
import cz.stremiooffline.tv.playback.Progress
import cz.stremiooffline.tv.playback.detectCapabilities
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

  val playerFocus = remember { FocusRequester() }
  val playFocus = remember { FocusRequester() }
  val osdShown = controls && state.started && state.error == null
  LaunchedEffect(controls, state.started, state.error) {
    when {
      osdShown -> runCatching { playFocus.requestFocus() }
      state.started && state.error == null -> runCatching { playerFocus.requestFocus() }
    }
  }

  LaunchedEffect(attempt) {
    val source = runCatching { api.librarySource(target.path) }.getOrNull()
    if (source == null) {
      controller.onNetworkError()
      return@LaunchedEffect
    }
    controller.start(source.sourceId, Progress.libraryKey(target.path), target.title, target.path, resume = target.resume)
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
    exoPlayer.playWhenReady = true
  }

  DisposableEffect(exoPlayer) {
    val listener = object : Player.Listener {
      override fun onIsPlayingChanged(isPlaying: Boolean) {
        playing = isPlaying
        if (isPlaying) controller.onPlaying() else controller.onPaused()
      }

      override fun onPlaybackStateChanged(playbackState: Int) {
        if (playbackState == Player.STATE_ENDED) controller.onEnded()
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
      if (event == Lifecycle.Event.ON_STOP) {
        exoPlayer.pause()
        controller.stop()
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
    onSeek = { controller.seekTo(it) },
    onTogglePause = { if (playing) exoPlayer.pause() else exoPlayer.play() },
    onExit = onExit,
    modifier = Modifier.then(if (osdShown) Modifier else Modifier.focusRequester(playerFocus).focusable())
      .onPreviewKeyEvent { event ->
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

/** The media keys work whether or not the OSD is up; a null answer means the key is not ours. */
private fun mediaKey(key: Key, player: ExoPlayer, playing: Boolean, onExit: () -> Unit): Boolean? = when (key) {
  Key.MediaPlayPause -> { if (playing) player.pause() else player.play(); true }
  Key.MediaPlay -> { player.play(); true }
  Key.MediaPause -> { player.pause(); true }
  Key.MediaFastForward -> { player.seekTo(player.currentPosition + (SEEK_STEP_SECONDS * 1000).toLong()); true }
  Key.MediaRewind -> { player.seekTo((player.currentPosition - (SEEK_STEP_SECONDS * 1000).toLong()).coerceAtLeast(0)); true }
  Key.Back -> { onExit(); true }
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
