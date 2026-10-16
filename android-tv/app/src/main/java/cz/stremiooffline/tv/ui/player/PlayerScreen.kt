@file:OptIn(UnstableApi::class)

package cz.stremiooffline.tv.ui.player

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.PowerManager
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
import androidx.compose.runtime.rememberCoroutineScope
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
import cz.stremiooffline.tv.catalog.ProgressKey
import cz.stremiooffline.tv.catalog.Streams
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.AddonSubtitleDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.data.TvPreferences
import cz.stremiooffline.tv.diagnostics.AppLog
import cz.stremiooffline.tv.playback.NextEpisode
import cz.stremiooffline.tv.playback.PlaybackController
import cz.stremiooffline.tv.playback.PlaybackDiagnostics
import cz.stremiooffline.tv.playback.PlaybackMode
import cz.stremiooffline.tv.playback.PlayerTrack
import cz.stremiooffline.tv.playback.PlayerTrackGroup
import cz.stremiooffline.tv.playback.Progress
import cz.stremiooffline.tv.playback.QualityChoice
import cz.stremiooffline.tv.playback.SidecarState
import cz.stremiooffline.tv.playback.SubtitleChoice
import cz.stremiooffline.tv.playback.SubtitleDelay
import cz.stremiooffline.tv.playback.VersionProgress
import cz.stremiooffline.tv.playback.VttCue
import cz.stremiooffline.tv.playback.absoluteCues
import cz.stremiooffline.tv.playback.activeCue
import cz.stremiooffline.tv.playback.browserCapabilities
import cz.stremiooffline.tv.playback.detectCapabilities
import cz.stremiooffline.tv.playback.diagPath
import cz.stremiooffline.tv.playback.matchTrack
import cz.stremiooffline.tv.playback.nextEpisodeOf
import cz.stremiooffline.tv.playback.parseVtt
import cz.stremiooffline.tv.playback.qualityChoice
import cz.stremiooffline.tv.playback.sidecarAdvanced
import cz.stremiooffline.tv.playback.sidecarPollDelay
import cz.stremiooffline.tv.playback.sidecarRefresh
import cz.stremiooffline.tv.ui.catalog.SourcesPanel
import cz.stremiooffline.tv.ui.catalog.RemoteSourcesFailure
import cz.stremiooffline.tv.ui.detail.PlayTarget
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.android.awaitFrame
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

const val TagRemoteSourcesRetry = "player_remote_sources_retry"

@Composable
fun PlayerScreen(
  api: TvApi,
  target: PlayTarget,
  /** Leaving reports the source the session ended on, so the caller can keep naming it. */
  onExit: (String?) -> Unit,
  /** The other sources the caller offers for this title; a library file has none. */
  sources: List<StreamDto> = emptyList(),
  /** The caller is still waiting on addons, so the list above may still grow. */
  sourcesLoading: Boolean = false,
  /** A remote source group that failed, named in the panel and retryable. */
  sourcesRemoteFailure: RemoteSourcesFailure? = null,
  /** Re-runs only the caller's source discovery, leaving the running session alone. */
  onSourcesRetry: (() -> Unit)? = null,
) {
  val context = LocalContext.current
  val lifecycle = LocalLifecycleOwner.current.lifecycle
  // The device's own decoders decide the routing and the labels; "Prefer server conversion" only
  // changes the lists the start sends, so the server treats the TV like a browser.
  val capabilities = remember { detectCapabilities(context) }
  val startCapabilities = remember(capabilities) {
    if (TvPreferences(context).preferConversion) browserCapabilities(capabilities) else capabilities
  }
  // The teardown save and delete must outlive the composition, so the controller gets its own
  // scope rather than the one Compose cancels on dispose.
  val sessionScope = remember { CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate) }
  val controller = remember(api) { PlaybackController(api, sessionScope, System::currentTimeMillis, capabilities, startCapabilities) }
  // Interactive calls (a source switch, Try again) must die with the screen, so a late account read
  // can never start a session after the viewer left.
  val scope = rememberCoroutineScope()
  val state by controller.state.collectAsStateWithLifecycle()

  val exoPlayer = remember(api) {
    ExoPlayer.Builder(context)
      .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(api.http)))
      .build()
  }
  val mediaSession = remember(exoPlayer) { MediaSession.Builder(context, exoPlayer).build() }

  var attempt by remember { mutableIntStateOf(0) }
  // The episode the start effect starts. A next episode replaces it, so Try again after a failed
  // next start restarts that episode instead of the title the player was opened on.
  var currentTarget by remember(target) { mutableStateOf(target) }
  var loadedUrl by remember { mutableStateOf<String?>(null) }
  var playing by remember { mutableStateOf(false) }
  // The intent to play: true from the start, so the OSD offers Pause while the video is still buffering.
  var wantsPlay by remember { mutableStateOf(true) }
  // The set stays awake for as long as the viewer means to be watching and nothing has failed.
  KeepScreenOn(enabled = wantsPlay && state.error == null)
  var position by remember { mutableDoubleStateOf(0.0) }
  // Set once the session has been released. Coming back starts a fresh one, paused, at the
  // position left behind. A screensaver does not set this: the same session stays.
  var parked by remember { mutableStateOf(false) }
  var startPaused by remember { mutableStateOf(false) }
  // The window lost its target while a screensaver or another activity covered it.
  var reclaimFocus by remember { mutableIntStateOf(0) }
  var settings by remember { mutableStateOf(SettingsResponse()) }
  var addonSubtitles by remember { mutableStateOf<List<AddonSubtitleDto>>(emptyList()) }
  var addonFetched by remember { mutableStateOf(false) }
  // The name the OSD and the loading overlay show; it follows the next episode too.
  var title by remember(target.key) { mutableStateOf(target.title) }
  // Subtitle polling runs only while the player is on screen: leaving the app releases the session.
  var resumed by remember { mutableStateOf(true) }

  var tracksOpen by remember { mutableStateOf(false) }
  var diagnosticsOpen by remember { mutableStateOf(false) }
  var sourcesOpen by remember { mutableStateOf(false) }
  var qualityOpen by remember { mutableStateOf(false) }
  // A source switch that has not landed yet: the target to retry, the target to go back to, and
  // the position both must resume at.
  var switchTarget by remember { mutableStateOf<PlayTarget?>(null) }
  var previousTarget by remember { mutableStateOf<PlayTarget?>(null) }
  var switchAt by remember { mutableDoubleStateOf(0.0) }
  // The button that opened a panel takes the remote back once the panel and its focus trap are
  // gone; the request waits for the frame that removed them.
  var restoreFocus by remember { mutableStateOf<FocusRequester?>(null) }
  var nextEpisode by remember { mutableStateOf<NextEpisode?>(null) }
  var nextCard by remember { mutableStateOf(false) }
  // A next episode replaces the file the caller's list was gathered for, so its addon rows name
  // the episode that just ended. The list is dropped with it rather than offered for the new file.
  var fileReplaced by remember { mutableStateOf(false) }
  // The correction lives with this playback, not beyond it.
  var delaySeconds by remember(target.key) { mutableDoubleStateOf(0.0) }
  var cues by remember { mutableStateOf<List<VttCue>>(emptyList()) }

  val currentState by rememberUpdatedState(state)
  val currentNext by rememberUpdatedState(nextEpisode)

  /** Every way out of the player releases the session first, whether or not the caller unmounts us. */
  val leave = {
    controller.release()
    onExit(state.sourceId)
  }

  val tracksFocus = remember { FocusRequester() }
  val tracksEntry = remember { FocusRequester() }
  val sourcesFocus = remember { FocusRequester() }
  val sourcesEntry = remember { FocusRequester() }
  val qualityFocus = remember { FocusRequester() }
  val qualityEntry = remember { FocusRequester() }
  val diagnosticsFocus = remember { FocusRequester() }
  val playFocus = remember { FocusRequester() }
  val nextFocus = remember { FocusRequester() }

  LaunchedEffect(restoreFocus) {
    val target = restoreFocus ?: return@LaunchedEffect
    // The panel is gone only once the frame that removed it is applied. Asking for the button in
    // the same frame lets the removal take the focus back to the OSD's first control on a device,
    // so the request waits a frame the way `SidePanel` does when it opens.
    awaitFrame()
    // A failed start brings the error panel up in the meantime; that panel owns the remote then.
    // A switch takes its opener away with the session, so Play catches the remote rather than
    // leaving the D-pad with nothing to move from.
    if (state.error == null) {
      runCatching { target.requestFocus() }.onFailure { runCatching { playFocus.requestFocus() } }
    }
    restoreFocus = null
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

    val audioMatch = if (snapshot.mode == PlaybackMode.Direct) matchTrack(snapshot.audioTracks, snapshot.audioTrackIndex, groups, C.TRACK_TYPE_AUDIO) else null
    if (audioMatch != null) {
      val mediaGroup = exoPlayer.currentTracks.groups[audioMatch.groupIndex].mediaTrackGroup
      builder.setOverrideForType(TrackSelectionOverride(mediaGroup, audioMatch.trackIndex))
    } else {
      builder.clearOverridesOfType(C.TRACK_TYPE_AUDIO)
    }

    val embedded = snapshot.subtitle as? SubtitleChoice.Embedded
    val textDirect = snapshot.mode == PlaybackMode.Direct && embedded != null && snapshot.sidecarUrl == null
    val textMatch = if (textDirect) matchTrack(snapshot.subtitleTracks, embedded!!.index, groups, C.TRACK_TYPE_TEXT) else null
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
    fileReplaced = true
    delaySeconds = 0.0
    cues = emptyList()
    title = next.title
    currentTarget = PlayTarget(key = Progress.libraryKey(next.path), title = next.title, resume = false, path = next.path)
    // The source is minted inside the controller, after the outgoing session is saved and deleted.
    controller.playNext(
      key = Progress.libraryKey(next.path),
      title = next.title,
      path = next.path,
      resume = false,
    ) { runCatching { api.librarySource(next.path) }.getOrNull()?.sourceId }
  }

  // A new title left nothing behind: the cached list, the offer and the delay belong to one playback.
  LaunchedEffect(target.key) {
    addonFetched = false
    addonSubtitles = emptyList()
    nextEpisode = null
    nextCard = false
    fileReplaced = false
    tracksOpen = false
    diagnosticsOpen = false
    sourcesOpen = false
    qualityOpen = false
    switchTarget = null
    previousTarget = null
    switchAt = 0.0
    cues = emptyList()
  }

  /** The account's languages and the addon subtitles, read fresh before every start. */
  suspend fun readAccount(from: PlayTarget = currentTarget) {
    addonFetched = true
    settings = runCatching { api.settings() }.getOrDefault(SettingsResponse())
    // A remote version's external subtitles belong to the version the viewer chose; the catalogue's
    // addons are never asked, even for a matched title.
    if (from.remoteItem != null) {
      addonSubtitles = remoteSelectedSubtitles(from, sources)
      return
    }
    // A play of an actual file on disk mints its source from a path and takes no catalogue addon
    // subtitles: the identity a native detail carries on such a target is there for the generic
    // row a switch may land on later, not for the file itself.
    val type = from.subtitleType.takeIf { from.path == null }
    val id = from.subtitleTarget
    addonSubtitles = if (type != null && id != null) runCatching { api.subtitles(type, id) }.getOrDefault(emptyList()) else emptyList()
  }

  // The sources the caller offers in its own order; an addon's notice is not a source. A play the
  // catalogue never started has none, so both the button and the panel stay away. A next episode
  // replaces the file those sources belong to, and they go with it.
  val offeredSources = Streams.offeredStreams(if (fileReplaced) emptyList() else sources)
  val sourcesAsking = sourcesLoading && !fileReplaced
  // The row the session plays: an addon one by its source id, a library copy by the path it plays.
  // A blank source id names no source, so it marks no row; a source id match wins over a path one,
  // because an addon source chosen over a library file leaves that file's path on the session.
  val playingSource = offeredSources.firstOrNull { it.sourceId.isNotBlank() && it.sourceId == state.sourceId }
    ?: offeredSources.firstOrNull { Streams.isLocalStream(it) && it.localPath != null && it.localPath == currentTarget.path }
  // The panel lists the row that is playing first, the rest in their own order.
  val panelSources = sourcesWithPlayingFirst(offeredSources, playingSource)
  val quality = qualityChoice(state.quality, state.escalatedByViewer)

  /** Starts [target], leaving the outgoing session saved and deleted behind it. A different remote
   *  version of an item no title names is a different file and begins at 0; a same-version restart,
   *  and a switch between two versions of one nameable title, keeps [at]. */
  fun startSwitch(target: PlayTarget, at: Double) {
    val startAt = sourceSwitchPosition(currentTarget.remoteItem, target.remoteItem, target.key, at)
    // The tracks the viewer has right now travel onto the new source, never the account defaults a
    // fresh session would have taken: a switch keeps what is on screen, position and language alike,
    // and the server is told the same choices.
    val trackChoice = controller.trackPreferences()
    title = target.title
    currentTarget = target
    scope.launch {
      // The addon subtitle ids are minted per sign-in session, so the new one gets fresh ones.
      readAccount(target)
      controller.start(
        sourceId = target.sourceId,
        key = target.key,
        title = target.title,
        path = target.path,
        resume = false,
        poster = target.poster,
        addonKey = target.addonKey,
        subtitles = addonSubtitles,
        trackChoice = trackChoice,
        at = startAt,
        // The source is minted inside the controller, after the outgoing session is closed.
        mint = target.path?.let { path -> { runCatching { api.librarySource(path) }.getOrNull()?.sourceId?.takeIf { it.isNotBlank() } } },
        remoteItem = target.remoteItem,
        stableKey = target.stableKey,
      )
    }
  }

  /** Choosing a row: the one already playing only closes the panel, any other starts a new session. */
  fun chooseSource(stream: StreamDto) {
    sourcesOpen = false
    restoreFocus = sourcesFocus
    if (playingSource === stream) return
    val target = switchedTarget(currentTarget, stream)
    previousTarget = currentTarget
    switchTarget = target
    switchAt = controller.position
    startSwitch(target, switchAt)
  }

  fun chooseQuality(quality: Int?) {
    qualityOpen = false
    restoreFocus = qualityFocus
    controller.selectQuality(quality)
  }

  // Once a session has landed, the switch it came from is no longer something to go back from.
  LaunchedEffect(state.started) {
    if (state.started) {
      switchTarget = null
      previousTarget = null
    }
  }

  LaunchedEffect(attempt) {
    val episode = currentTarget
    // A catalogue target already carries the server's source id; a library one is minted from its path.
    val sourceId = episode.sourceId ?: episode.path?.let { runCatching { api.librarySource(it) }.getOrNull()?.sourceId }
    if (sourceId == null) {
      controller.onNetworkError()
      return@LaunchedEffect
    }
    // The account's languages and the addon subtitles are read just before the start: the ids are
    // minted per sign-in session and are short-lived, so they cannot be fetched any earlier.
    if (!addonFetched) readAccount()
    controller.start(
      sourceId = sourceId,
      key = episode.key,
      title = episode.title,
      path = episode.path,
      resume = episode.resume,
      poster = episode.poster,
      addonKey = episode.addonKey,
      subtitles = addonSubtitles,
      audioPreference = settings.audioLanguage,
      subtitlePreference = settings.subtitleLanguage,
      remoteItem = episode.remoteItem,
      stableKey = episode.stableKey,
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
      override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
        wantsPlay = playWhenReady
      }

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
  LaunchedEffect(state.started, state.startedAt, state.sourceId, target.path) {
    if (!state.started || target.path == null) return@LaunchedEffect
    val id = state.sourceId ?: return@LaunchedEffect
    nextEpisode = runCatching { api.libraryNext(id) }.getOrNull()?.let(::nextEpisodeOf)
  }

  val sidecar = state.sidecarUrl
  val embeddedChoice = state.subtitle as? SubtitleChoice.Embedded
  val addonChoice = state.subtitle as? SubtitleChoice.Addon
  val sidecarActive = sidecar != null && embeddedChoice != null
  val resolvedAddonId = addonChoice?.let { state.subtitleIds[it.subtitleId] ?: it.subtitleId }

  // The sidecar is polled the way the web watches it; a 404 only means "come back". It stops while
  // the app is in the background, where the session is gone, and resumes with the new one.
  LaunchedEffect(resumed, sidecarActive, sidecar, delaySeconds) {
    if (!resumed || sidecar == null || embeddedChoice == null) return@LaunchedEffect
    var watcher = SidecarState()
    cues = emptyList()
    // The flag is read every pass too: while the app is stopped the composition is paused, so the
    // key alone would not cancel a loop that is already suspended in its poll delay.
    while (isActive && resumed) {
      val at = controller.position
      val fetch = runCatching { api.sidecar(sidecar, at, delaySeconds) }.getOrNull()
      if (fetch != null) {
        if (sidecarRefresh(watcher, fetch.coverage, fetch.complete, at)) {
          // The server rebases its cues to the conversion stream; the picture the overlay is
          // compared with is absolute, so the offset goes back on.
          cues = absoluteCues(parseVtt(fetch.text), state.offset)
          watcher = sidecarAdvanced(watcher, fetch.coverage, fetch.complete)
        }
        if (fetch.complete) return@LaunchedEffect
      }
      delay(sidecarPollDelay(watcher, controller.position))
    }
  }

  // An addon subtitle is read once, and again whenever the delay moves it or a new session starts.
  LaunchedEffect(resumed, addonChoice, resolvedAddonId, delaySeconds, state.offset) {
    if (!resumed || addonChoice == null || resolvedAddonId == null) return@LaunchedEffect
    cues = emptyList()
    val text = runCatching { api.subtitleText(resolvedAddonId, state.offset, delaySeconds) }.getOrNull() ?: return@LaunchedEffect
    cues = absoluteCues(parseVtt(text), state.offset)
  }

  LaunchedEffect(state.trackRevision) {
    if (!sidecarActive && addonChoice == null) cues = emptyList()
  }

  // Home, Recents and the screen turning off release the session. The screensaver stops the
  // activity too, but the viewer is still on this film: deleting the session there left the remote
  // with nothing to focus until a new one had been opened.
  fun park() {
    if (parked) return
    parked = true
    AppLog.info("Playback parked")
    resumed = false
    exoPlayer.pause()
    loadedUrl = null
    controller.stop()
    PlayerLeave.requested = false
  }

  DisposableEffect(lifecycle, context) {
    val observer = LifecycleEventObserver { _, event ->
      when (event) {
        Lifecycle.Event.ON_STOP -> {
          val interactive = (context.getSystemService(Context.POWER_SERVICE) as PowerManager).isInteractive
          if (releasePlaybackOnStop(PlayerLeave.requested, interactive, PlayerDream.active)) {
            park()
          } else {
            AppLog.info("Screensaver stop")
            exoPlayer.pause()
          }
        }
        Lifecycle.Event.ON_START -> {
          // Visible again, so a dream that ended without its broadcast cannot suppress the next leave.
          PlayerDream.active = false
          reclaimFocus++
          if (!parked) return@LifecycleEventObserver
          AppLog.info("Lifecycle start")
          parked = false
          resumed = true
          startPaused = true
          nextCard = false
          controller.retry()
        }
        else -> Unit
      }
    }
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(ctx: Context?, intent: Intent?) {
        when (intent?.action) {
          Intent.ACTION_DREAMING_STARTED -> PlayerDream.active = true
          Intent.ACTION_DREAMING_STOPPED -> PlayerDream.active = false
          // Standby after a screensaver never stops the activity a second time.
          Intent.ACTION_SCREEN_OFF -> park()
        }
      }
    }
    val filter = IntentFilter().apply {
      addAction(Intent.ACTION_DREAMING_STARTED)
      addAction(Intent.ACTION_DREAMING_STOPPED)
      addAction(Intent.ACTION_SCREEN_OFF)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      context.registerReceiver(receiver, filter)
    }
    lifecycle.addObserver(observer)
    onDispose {
      lifecycle.removeObserver(observer)
      context.unregisterReceiver(receiver)
    }
  }

  // A fatal playback error goes to the server once, through the rate-limited single-line route;
  // the full buffer travels with the next diagnostics bundle from Settings.
  LaunchedEffect(state.error) {
    val error = state.error ?: return@LaunchedEffect
    val kind = error::class.simpleName.orEmpty()
    if (AppLog.allowWarn("player:$kind")) api.clientLog("WARN", "Player error: $kind")
  }

  DisposableEffect(Unit) {
    onDispose {
      controller.release()
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
  val subtitleText = activeCue(cues, position)?.takeIf { it.isNotBlank() }
  val sourcesTitle = stringResource(R.string.sources_heading)
  val remoteFailureNote = sourcesRemoteFailure?.let { failure ->
    if (failure.discovery) stringResource(R.string.media_server_error)
    else stringResource(R.string.media_server_group_failed, failure.labels.joinToString(", "))
  }
  val qualityText = qualityLabel(quality)
  // Both panels act on the running session, so their buttons wait for it: a choice made before
  // the first descriptor lands would be dropped.
  val sourcesShown = state.started && (offeredSources.size > 1 || sourcesAsking)
  val qualityShown = state.started

  PlayerOverlayShell(
    position = position,
    duration = state.duration,
    playing = playing,
    pauseShown = wantsPlay,
    title = title,
    // Before the server answers there is no path to name; a failed start must not claim direct play.
    eyebrow = if (state.started) stringResource(pathLabel(diagPath(state.mode, state.copyAudio))) else "",
    playFocus = playFocus,
    reclaimFocus = reclaimFocus,
    seekKept = state.seekKept,
    modal = tracksOpen || diagnosticsOpen || sourcesOpen || qualityOpen || nextCard || state.error != null,
    onSeek = { controller.seekTo(it) },
    onTogglePause = { if (exoPlayer.playWhenReady) exoPlayer.pause() else exoPlayer.play() },
    onExit = leave,
    onTracks = { tracksOpen = true },
    tracksText = tracksButtonText(state.audioTrack?.language),
    tracksLabel = stringResource(R.string.tv_tracks_title),
    tracksFocus = tracksFocus,
    onSources = if (sourcesShown) ({ sourcesOpen = true }) else null,
    sourcesText = sourcesTitle,
    sourcesLabel = sourcesTitle,
    sourcesFocus = sourcesFocus,
    onQuality = if (qualityShown) ({ qualityOpen = true }) else null,
    qualityText = qualityText,
    qualityLabel = qualityText,
    qualityFocus = qualityFocus,
    onNext = if (currentNext != null) ({ startNext() }) else null,
    nextLabel = stringResource(R.string.player_next_episode),
    onDiagnostics = { diagnosticsOpen = true },
    diagnosticsLabel = stringResource(R.string.diag_title),
    diagnosticsFocus = diagnosticsFocus,
    subtitleText = subtitleText,
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

      if (sourcesOpen) {
        SourcesPanel(
          streams = panelSources,
          focusIndex = 0,
          onChoose = { chooseSource(it) },
          onClose = {
            sourcesOpen = false
            restoreFocus = sourcesFocus
          },
          default = Streams.pickDefaultStream(panelSources),
          playing = playingSource,
          asking = sourcesAsking,
          emptyText = stringResource(R.string.sources_none),
          failureText = stringResource(R.string.tv_load_error),
          remoteNote = remoteFailureNote,
          onRetry = if (sourcesRemoteFailure != null) onSourcesRetry else null,
          retryTag = if (sourcesRemoteFailure != null) TagRemoteSourcesRetry else null,
          initialFocus = sourcesEntry,
        )
      }

      if (qualityOpen) {
        PlayerQualityPanel(
          choice = quality,
          onOriginal = { chooseQuality(null) },
          onHeight = { chooseQuality(it) },
          onForce = {
            qualityOpen = false
            restoreFocus = qualityFocus
            controller.escalate()
          },
          onClose = {
            qualityOpen = false
            restoreFocus = qualityFocus
          },
          initialFocus = qualityEntry,
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

      state.error?.let {
        val failed = switchTarget
        val previous = previousTarget
        ErrorPanel(
          onRetry = {
            // Try again always re-reads the account: the addon subtitle ids are minted per sign-in
            // session and short-lived, so a started session cannot reuse the ones it began with.
            // Try again is the new source, not the one the player started with.
            if (failed != null) {
              startSwitch(failed, switchAt)
            } else {
              scope.launch {
                playerRetry(
                  started = state.started,
                  readAccount = { readAccount() },
                  restart = { controller.retry(addonSubtitles, settings.audioLanguage, settings.subtitleLanguage) },
                  startOver = { attempt++ },
                )
              }
            }
          },
          onBack = leave,
          onBackToSource = previous?.let { back -> { startSwitch(back, switchAt) } },
        )
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

    if (state.error == null && !state.started) LoadingOverlay(title = title)
  }
}

/**
 * The media keys work whether or not the OSD is up; a null answer means the key is not ours. Back
 * is deliberately absent: the overlay's own rule owns it and hides the controls first.
 */
internal fun mediaKey(key: Key, player: ExoPlayer, playing: Boolean, onExit: (String?) -> Unit): Boolean? = when (key) {
  Key.MediaPlayPause -> { if (playing || player.playWhenReady) player.pause() else player.play(); true }
  Key.MediaPlay -> { player.play(); true }
  Key.MediaPause -> { player.pause(); true }
  else -> null
}

// A container the player cannot parse is handed to the server like a codec it cannot decode:
// ffmpeg rewrites a damaged or unusual file that ExoPlayer's extractors refuse.
internal fun isDecoderError(error: PlaybackException): Boolean = error.errorCode in setOf(
  PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED,
  PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
  PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
  PlaybackException.ERROR_CODE_DECODER_QUERY_FAILED,
  PlaybackException.ERROR_CODE_DECODING_FAILED,
  PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES,
  PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
)

/**
 * The error panel's Try again. The account is always read again first: the addon subtitle ids are
 * minted per sign-in session and short-lived, so even a session that had started cannot reuse the
 * ones it began with. A session that never answered is started from scratch; one that had started
 * is restarted where the player left off.
 */
internal suspend fun playerRetry(
  started: Boolean,
  readAccount: suspend () -> Unit,
  restart: suspend () -> Unit,
  startOver: () -> Unit,
) {
  readAccount()
  if (started) restart() else startOver()
}

/**
 * The rows the Sources panel draws: the one that is playing leads, everything else keeps the order
 * it arrived in. Nothing playing leaves the list exactly as it was.
 */
internal fun sourcesWithPlayingFirst(streams: List<StreamDto>, playing: StreamDto?): List<StreamDto> {
  val index = playing?.let(streams::indexOf) ?: -1
  if (index <= 0) return streams
  return listOf(streams[index]) + streams.filterIndexed { position, _ -> position != index }
}

/**
 * Where a switch lands. Two versions of one nameable title share one position, so a switch between
 * them carries it; an item no title names keeps its own store, so another version of it is another
 * file and starts at 0.
 */
internal fun sourceSwitchPosition(from: RemoteItemContext?, to: RemoteItemContext?, toKey: String, position: Double): Double =
  if (VersionProgress.titleOwned(toKey, to)) position
  else if (to != null && (from == null || from.libraryId != to.libraryId || from.itemId != to.itemId || from.mediaSourceId != to.mediaSourceId)) 0.0
  else position

/**
 * The target a chosen source switches to, built from the running target and the incoming row.
 *
 * The incoming row's own `remoteItem` is authoritative: a media-server version becomes a play of
 * exactly that item, under the running play's own title key when it has one -- the title owns the
 * position of a version the catalogue can name -- and under the item's own stable key otherwise,
 * with only the versions of that same library item either way.
 * A library copy becomes the file's own session, under the file's own key. An addon row keeps the
 * running title's own generic key and subtitles -- the catalogue key a catalogue play already
 * carries, or the identity a native detail loaded its addon rows under -- never the key of the
 * file or the remote version it was reached from, and never the row's opaque source id.
 *
 * The snapshot the caller handed over travels with every switch, so the player's list never
 * shrinks to the row it landed on and no kind of switch makes it discover anything itself.
 */
internal fun switchedTarget(current: PlayTarget, stream: StreamDto): PlayTarget {
  val incomingRemote = stream.remoteItem
  if (incomingRemote != null) {
    return PlayTarget(
      // A version of the title the running play already names is watched under that title's key;
      // an item nothing can name keeps its own item state.
      key = genericKeyOf(current) ?: incomingRemote.progressKey.ifEmpty { current.key },
      title = current.title,
      resume = false,
      sourceId = stream.sourceId.takeIf { it.isNotBlank() },
      stableKey = stream.stableKey,
      poster = current.poster,
      addonKey = current.addonKey,
      subtitleType = current.subtitleType,
      subtitleTarget = current.subtitleTarget,
      catalogue = current.catalogue,
      remoteItem = incomingRemote,
      // Only the same item's versions: another library or item never lends its list.
      remoteSources = Streams.remoteVersionsOf(incomingRemote, current.remoteSources + current.initialSources.orEmpty())
        .ifEmpty { listOf(stream) },
      initialSources = current.initialSources,
    )
  }
  val path = stream.localPath
  if (Streams.isLocalStream(stream) && path != null) {
    return PlayTarget(
      key = Progress.libraryKey(path),
      title = stream.behaviorHints?.filename?.takeIf { it.isNotBlank() } ?: current.title,
      resume = false,
      path = path,
      stableKey = stream.stableKey,
      poster = current.poster,
      addonKey = current.addonKey,
      subtitleType = current.subtitleType,
      subtitleTarget = current.subtitleTarget,
      catalogue = current.catalogue,
      initialSources = current.initialSources,
    )
  }
  // An ordinary addon row. A catalogue play and a native detail's play both carry the title's own
  // generic identity, which is the key this row keeps; a library file carries none, so the file's
  // own key stays what the addon row is watched under, as it always was.
  return PlayTarget(
    key = genericKeyOf(current) ?: current.key,
    title = current.title,
    resume = false,
    sourceId = stream.sourceId,
    stableKey = stream.stableKey,
    poster = current.poster,
    // The title's owner, never the row's own addon provider.
    addonKey = current.addonKey,
    subtitleType = current.subtitleType,
    subtitleTarget = current.subtitleTarget,
    catalogue = current.catalogue,
    initialSources = current.initialSources,
  )
}

/** The generic catalogue key the running target's own identity makes, if it carries one. */
private fun genericKeyOf(target: PlayTarget): String? {
  val type = target.subtitleType?.takeIf { it.isNotBlank() } ?: return null
  val id = target.subtitleTarget?.takeIf { it.isNotBlank() } ?: return null
  return ProgressKey.of(type, id)
}

/**
 * The external subtitles of the selected remote version: exactly the chosen stream's own list,
 * found by its id in the target's own versions or in the caller's offered ones. A remote stream
 * never borrows the catalogue's addon subtitles, matched or not.
 */
internal fun remoteSelectedSubtitles(target: PlayTarget, offered: List<StreamDto>): List<AddonSubtitleDto> {
  if (target.remoteItem == null) return emptyList()
  val selected = (target.remoteSources + offered).firstOrNull { it.sourceId.isNotBlank() && it.sourceId == target.sourceId }
  return selected?.subtitles.orEmpty()
}
