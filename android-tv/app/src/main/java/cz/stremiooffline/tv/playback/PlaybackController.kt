package cz.stremiooffline.tv.playback

import cz.stremiooffline.tv.catalog.Languages
import cz.stremiooffline.tv.data.AddonSubtitleDto
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.ClientCapabilitiesDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteItemStateDto
import cz.stremiooffline.tv.data.RemoteItemStatePatch
import cz.stremiooffline.tv.data.RemoteLibraryApi
import cz.stremiooffline.tv.data.RemotePlaybackReport
import cz.stremiooffline.tv.data.TrackChange
import cz.stremiooffline.tv.diagnostics.AppLog
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.math.round

private enum class ReportEvent(val wire: String) {
  Start("start"),
  Progress("progress"),
  Stop("stop"),
}

/** The playback calls of one server, taken straight off [cz.stremiooffline.tv.data.ApiClient]. */
interface PlaybackApi {
  suspend fun startPlayback(
    sourceId: String,
    capabilities: ClientCapabilitiesDto,
    time: Double,
    subtitleIds: List<String> = emptyList(),
    /** The viewer's own track choices; absent leaves them to the account's settings, which is what
     *  a first start does. */
    audioLanguage: String? = null,
    subtitleLanguage: String? = null,
    /** True when the viewer turned subtitles off: the server is told so explicitly, because an
     *  absent field would let the account's own subtitle language put one back. */
    subtitleOff: Boolean = false,
  ): PlaybackDescriptorDto

  suspend fun seekPlayback(id: String, time: Double): PlaybackDescriptorDto

  suspend fun trackPlayback(id: String, change: TrackChange): PlaybackDescriptorDto

  suspend fun escalatePlayback(id: String, time: Double): PlaybackDescriptorDto

  suspend fun pingPlayback(id: String)

  suspend fun deletePlayback(id: String)

  suspend fun progress(key: String): ProgressDto?

  suspend fun saveProgress(
    key: String,
    position: Double,
    duration: Double,
    title: String,
    path: String?,
    poster: String? = null,
    addonKey: String? = null,
    /** The media-server version the row was written by, for a title-owned play. */
    remote: RemoteItemContext? = null,
    /** The source the position was played from, so the detail can preselect it next time. */
    stableKey: String? = null,
  )
}

enum class PlaybackMode { Direct, Remux, Transcode }

sealed interface PlaybackError {
  data object Decoder : PlaybackError
  data object Network : PlaybackError
  data object Session : PlaybackError
}

/** The subtitle the viewer has chosen. The server never learns of an addon choice; the app
 *  renders it, while an embedded one is either selected in ExoPlayer or read by the server. */
sealed interface SubtitleChoice {
  data object Off : SubtitleChoice
  data class Embedded(val index: Int) : SubtitleChoice
  data class Addon(val subtitleId: String) : SubtitleChoice
}

/**
 * The track choices in effect in a session, as a switch onto another source must carry them: the
 * language the viewer is hearing, the language of the subtitle they are reading, and whether they
 * turned subtitles off -- which the server must be told explicitly, because it would otherwise put
 * the account's own subtitle back.
 */
data class TrackPreferences(
  val audio: String?,
  /** Null both when subtitles are off and when the chosen one names no language. */
  val subtitle: String?,
  val subtitleOff: Boolean,
)

/** What the player screen draws. `revision` changes whenever the media item must be (re)loaded;
 *  `trackRevision` changes when only the ExoPlayer track selection has to be applied again. */
data class PlaybackState(
  val loading: Boolean = false,
  val started: Boolean = false,
  val url: String? = null,
  val playlist: Boolean = false,
  val offset: Double = 0.0,
  val duration: Double = 0.0,
  val mode: PlaybackMode = PlaybackMode.Direct,
  val copyAudio: Boolean = true,
  val copyVideo: Boolean = true,
  /** The picture height that was chosen, or null for the server's own choice. */
  val quality: Int? = null,
  /** True once the viewer asked for a server conversion with the Quality panel this session. */
  val escalatedByViewer: Boolean = false,
  val audioTracks: List<DescriptorTrack> = emptyList(),
  val audioTrackIndex: Int = 0,
  val subtitleTracks: List<DescriptorTrack> = emptyList(),
  val subtitle: SubtitleChoice = SubtitleChoice.Off,
  val sidecarUrl: String? = null,
  val addonSubtitles: List<AddonSubtitleDto> = emptyList(),
  /** The id each addon subtitle must be fetched with, `map[id] ?: id`. */
  val subtitleIds: Map<String, String> = emptyMap(),
  val videoCodec: String? = null,
  val audioCodec: String? = null,
  /** The source id the current session plays, so a caller can ask the server for its neighbour. */
  val sourceId: String? = null,
  /** The absolute position the player should start or seek to after `revision` changes. */
  val target: Double = 0.0,
  val revision: Int = 0,
  val trackRevision: Int = 0,
  val startedAt: Long = 0L,
  /** Bumped when the server refused a seek; the screen shows the message for a few seconds. */
  val seekKept: Int = 0,
  val lastPingAt: Long? = null,
  val error: PlaybackError? = null,
) {
  val audioTrack: DescriptorTrack? get() = audioTracks.getOrNull(audioTrackIndex)
}

/**
 * The playback session of one title, free of Android types so the whole lifecycle can be
 * unit-tested. It owns the start, the seek debounce, the 30 s ping, the 10 s progress save, the
 * one escalate a decoder error is allowed and the `/track` round trip a conversion needs.
 */
class PlaybackController(
  private val api: PlaybackApi,
  private val scope: CoroutineScope,
  private val clock: () -> Long,
  private val capabilities: ClientCapabilitiesDto,
  /** What the start declares. "Prefer server conversion" empties the native lists here only;
   *  [capabilities] keeps the device's real decoders for the routing and the labels. */
  private val startCapabilities: ClientCapabilitiesDto = capabilities,
) {
  private val _state = MutableStateFlow(PlaybackState())
  val state: StateFlow<PlaybackState> = _state.asStateFlow()

  private var sessionId: String? = null
  private var sourceId: String? = null
  private var playlist = false
  private var offset = 0.0
  private var duration = 0.0
  private var mode = PlaybackMode.Direct
  private var copyAudio = true
  private var copyVideo = true
  private var quality: Int? = null
  private var audioTracks: List<DescriptorTrack> = emptyList()
  private var subtitleTracks: List<DescriptorTrack> = emptyList()
  private var subtitle: SubtitleChoice = SubtitleChoice.Off

  private var key = ""
  private var title = ""
  private var path: String? = null
  private var poster: String? = null
  private var addonKey: String? = null
  /** The stable handle of the row this session plays, written with every progress save. */
  private var stableKey: String? = null
  /** Set only for a native remote play: the identity whose position the title's own key holds, or
   *  whose own remote-state endpoint holds it when nothing can name the title. */
  private var remote: RemoteItemContext? = null
  /** The identity a `start` was sent for in this session; null while no start report exists. */
  private var reported: RemoteItemContext? = null
  /** Reports leave one at a time, in order: a progress that overtook a stop would reopen the
   *  media server's session until its idle timeout. */
  private val reportLock = Mutex()

  private data class StartPlan(
    /** The source the start uses; null when [mint] has to produce one. */
    val sourceId: String?,
    val key: String,
    val title: String,
    val path: String?,
    val explicitTime: Double?,
    val resume: Boolean,
    val poster: String?,
    val addonKey: String?,
    val subtitles: List<AddonSubtitleDto>,
    val audioPreference: String?,
    val subtitlePreference: String?,
    val library: Boolean,
    /** The viewer's own track choices, named on the wire; null leaves them to the account's
     *  settings, which is what every start but a switch does. */
    val trackChoice: TrackPreferences? = null,
    /** The stable handle of the row this session plays, saved with every progress write. */
    val stableKey: String? = null,
    /** A fresh source is minted after the outgoing session is closed, never before it. */
    val mint: (suspend () -> String?)? = null,
    /** The client's own subtitle choice, carried across a restart of the same session. */
    val carrySubtitle: SubtitleChoice? = null,
    /** The native remote identity this session plays, or null for a filesystem or addon play. */
    val remote: RemoteItemContext? = null,
  )

  private var plan: StartPlan? = null

  private var playing = false
  private var ready = false
  private var hasPosition = false
  private var lastPosition = 0.0
  private var escalated = false
  /** The viewer's own escalate from the Quality panel; a decoder error never sets it. */
  private var escalatedByViewer = false
  private var recovered = false
  private var stopped = true
  /** The screen is gone for good; a late answer must not start a session, however long it took. */
  private var released = false

  private var pingJob: Job? = null
  private var saveJob: Job? = null
  private var reportJob: Job? = null
  private var seekJob: Job? = null
  private var trackJob: Job? = null
  private var pendingSeek: Double? = null
  private var sequence = 0
  /** Bumped by every start and stop, so a late answer from a superseded request is dropped. */
  private var generation = 0
  /** The absolute position a restart began at, kept until a descriptor lands so a failed restart
   *  is recovered there rather than at the new session's zero. */
  private var restartAt: Double? = null

  /** The absolute position, converted through the HLS offset the way the spec defines it. */
  val position: Double get() = absolute(lastPosition)

  /** Where a restart goes: the place it began at, or the position the player is at now. */
  private val restartPosition: Double get() = restartAt ?: position

  /**
   * The track choices in effect right now, as a switch onto another source must carry them: the
   * spoken language the viewer is hearing, and the language of the embedded or addon subtitle they
   * are reading -- or none at all, which the server has to be told explicitly. Nothing is read from
   * the account's own preferences: those decided the session's start, not what the viewer chose
   * inside it.
   */
  fun trackPreferences(): TrackPreferences {
    val snapshot = _state.value
    val audio = audioTracks.getOrNull(snapshot.audioTrackIndex)?.language ?: plan?.audioPreference
    val subtitle = when (val choice = snapshot.subtitle) {
      is SubtitleChoice.Embedded -> subtitleTracks.getOrNull(choice.index)?.language
      is SubtitleChoice.Addon -> snapshot.addonSubtitles.firstOrNull { it.subtitleId == choice.subtitleId }?.lang
      SubtitleChoice.Off -> null
    }
    return TrackPreferences(audio, subtitle, subtitleOff = snapshot.subtitle is SubtitleChoice.Off)
  }

  private fun absolute(playerPosition: Double) = if (playlist) offset + playerPosition else playerPosition

  private fun startPlan(
    sourceId: String?,
    key: String,
    title: String,
    path: String?,
    explicitTime: Double?,
    resume: Boolean,
    poster: String?,
    addonKey: String?,
    subtitles: List<AddonSubtitleDto>,
    audioPreference: String?,
    subtitlePreference: String?,
    trackChoice: TrackPreferences? = null,
    stableKey: String? = null,
    mint: (suspend () -> String?)? = null,
    carrySubtitle: SubtitleChoice? = null,
    remote: RemoteItemContext? = null,
  ) = StartPlan(sourceId, key, title, path, explicitTime, resume, poster, addonKey, subtitles, audioPreference, subtitlePreference, library = path != null, trackChoice = trackChoice, stableKey = stableKey, mint = mint, carrySubtitle = carrySubtitle, remote = remote)

  /**
   * Starts a session for [key]. [sourceId] is a source the server already handed out; when it is
   * absent [mint] produces one after the outgoing session is closed. [at] is an explicit position,
   * which a resume reads from the stored progress instead.
   */
  fun start(
    sourceId: String?,
    key: String,
    title: String,
    path: String?,
    resume: Boolean,
    poster: String? = null,
    addonKey: String? = null,
    subtitles: List<AddonSubtitleDto> = emptyList(),
    audioPreference: String? = null,
    subtitlePreference: String? = null,
    at: Double? = null,
    remoteItem: RemoteItemContext? = null,
    mint: (suspend () -> String?)? = null,
    /** The stable handle of the row being played, saved with the position. */
    stableKey: String? = null,
    /** The viewer's own track choices; only a switch inside a session names them. */
    trackChoice: TrackPreferences? = null,
  ) {
    if (released) return
    begin(startPlan(sourceId, key, title, path, at, resume, poster, addonKey, subtitles, audioPreference, subtitlePreference, trackChoice = trackChoice, stableKey = stableKey, mint = mint, remote = remoteItem))
  }

  /** Starts the next library file: the old session is saved and deleted before the new start. */
  fun playNext(
    key: String,
    title: String,
    path: String?,
    resume: Boolean,
    poster: String? = null,
    mint: suspend () -> String?,
  ) {
    if (released) return
    val current = plan ?: return
    begin(startPlan(null, key, title, path, null, resume, poster, current.addonKey, current.subtitles, current.audioPreference, current.subtitlePreference, mint = mint))
  }

  /**
   * Retries a failed start at the position the player last reported. The addon subtitles and the
   * account languages are taken fresh: the ids are minted per sign-in session and short-lived.
   */
  fun retry(
    subtitles: List<AddonSubtitleDto> = plan?.subtitles ?: emptyList(),
    audioPreference: String? = plan?.audioPreference,
    subtitlePreference: String? = plan?.subtitlePreference,
  ) {
    if (released) return
    val current = plan ?: return
    begin(
      current.copy(
        explicitTime = restartPosition,
        resume = false,
        subtitles = subtitles,
        audioPreference = audioPreference,
        subtitlePreference = subtitlePreference,
        carrySubtitle = _state.value.subtitle,
      ),
    )
  }

  private fun begin(next: StartPlan) {
    val mine = ++generation
    AppLog.info("Session start", mapOf("source" to (next.sourceId ?: "mint")))
    // A start that is still in flight is left to finish: the session it may have already created
    // on the server is deleted when its answer arrives, rather than leaked to the reaper.
    cancelLoops()
    val previousId = sessionId
    // The outgoing identity is captured before the new plan replaces it, so a switch between two
    // versions of one remote item still saves under the same stable key.
    val previous = if (previousId != null && hasPosition) SavePayload(key, position, duration, title, path, poster, addonKey, remote, stableKey) else null
    val outgoingReported = reported
    val outgoingPosition = position
    val outgoingPaused = !playing
    reported = null
    sessionId = null
    plan = next
    sourceId = next.sourceId
    key = next.key
    title = next.title
    path = next.path
    poster = next.poster
    addonKey = next.addonKey
    stableKey = next.stableKey
    remote = next.remote
    playing = false
    ready = false
    hasPosition = false
    lastPosition = 0.0
    escalated = false
    escalatedByViewer = false
    recovered = false
    stopped = false
    playlist = false
    offset = 0.0
    duration = 0.0
    copyAudio = true
    copyVideo = true
    quality = null
    mode = PlaybackMode.Direct
    audioTracks = emptyList()
    subtitleTracks = emptyList()
    subtitle = SubtitleChoice.Off
    _state.value = PlaybackState(loading = true, startedAt = clock())
    scope.launch {
      // The outgoing stop reaches the server before the new start is asked for.
      if (outgoingReported != null) sendReport(ReportEvent.Stop, outgoingReported, outgoingPosition, outgoingPaused)
      // The outgoing session is closed first, in one coroutine, so the save and the delete are
      // seen before the new start rather than raced with it.
      if (previous != null) runCatching { save(previous) }
      if (previousId != null) runCatching { api.deletePlayback(previousId) }
      if (mine != generation) return@launch
      // The outgoing session is closed before the new source is minted: a failure to close it must
      // not leave a source behind that nobody ever starts.
      val resolved = next.sourceId ?: next.mint?.invoke()?.takeIf { it.isNotBlank() }
      if (resolved == null) {
        if (mine == generation) _state.update { it.copy(loading = false, error = PlaybackError.Network) }
        return@launch
      }
      sourceId = resolved
      val resumeTime = next.explicitTime ?: if (next.resume) storedResumeTime(next) else 0.0
      if (mine != generation) return@launch
      if (resumeTime > 0) lastPosition = resumeTime
      val offered = next.subtitles.map { it.subtitleId }.take(MAX_SUBTITLE_IDS)
      // The viewer's own choice of track is named on the wire, so a switch lands on the languages
      // that were in effect rather than on the account's. A start without one names nothing.
      val choice = next.trackChoice
      val descriptor = runCatching {
        api.startPlayback(
          resolved,
          startCapabilities,
          resumeTime,
          offered,
          audioLanguage = choice?.audio,
          subtitleLanguage = choice?.subtitle,
          subtitleOff = choice?.subtitleOff == true,
        )
      }.getOrElse { error ->
        if (mine == generation) _state.update { it.copy(loading = false, error = errorOf(error)) }
        return@launch
      }
      if (mine != generation) {
        deleteSession(descriptor.id)
        return@launch
      }
      apply(descriptor, target = resumeTime, plan = next)
      startLoops()
      val context = next.remote
      if (context != null && VersionProgress.writer(context) != null) {
        reported = context
        report(ReportEvent.Start, context, position, paused = true)
      }
    }
  }

  /**
   * Where a resume begins. A native remote play reads the title's own row when its key names one,
   * and otherwise the local remote-state store; everything else reads the generic progress route it
   * always did. A stored position from the item's own store is used only for the same version: no
   * proof of cross-version compatibility exists, so another version starts at 0.
   */
  private suspend fun storedResumeTime(next: StartPlan): Double {
    val context = next.remote
    if (context == null) {
      val stored = readProgress(next.key) ?: return 0.0
      return Progress.resumePosition(stored.position, stored.duration) ?: 0.0
    }
    val state = VersionProgress.savedState(
      next.key.takeIf { VersionProgress.titleOwned(it, context) },
      context,
      ::readProgress,
      { libraryId, itemId -> remoteApi().remoteItemState(libraryId, itemId) },
    ) ?: return 0.0
    // An item marked watched has no position to resume: like the web, it starts from the beginning.
    if (state.watched) return 0.0
    if (state.mediaSourceId == null || state.mediaSourceId != context.mediaSourceId) return 0.0
    return Progress.resumePosition(state.position, state.duration) ?: 0.0
  }

  private suspend fun readProgress(key: String): ProgressDto? = try {
    api.progress(key)
  } catch (cancelled: CancellationException) {
    throw cancelled
  } catch (_: ApiError) {
    null
  }

  fun onPlayerPosition(seconds: Double) {
    lastPosition = seconds
    // Before the player has prepared the item the position is meaningless, so it is kept for the
    // display but never saved; a seek answer confirms one of its own below.
    if (ready) hasPosition = true
  }

  /** The player has reached `STATE_READY` for the item, so its position is worth keeping. */
  fun onPlayerReady() {
    ready = true
  }

  fun onPlaying() {
    val changed = !playing
    playing = true
    if (changed && !stopped) report(ReportEvent.Progress, reported, position, paused = false)
  }

  fun onPaused() {
    val changed = playing
    playing = false
    saveNow()
    if (changed && !stopped) report(ReportEvent.Progress, reported, position, paused = true)
  }

  fun onEnded() {
    saveNow()
  }

  /** Direct play hands the seek to the player; HLS debounces it into one `/seek`. */
  fun seekTo(absolute: Double) {
    if (stopped || sessionId == null) return
    if (!playlist) {
      lastPosition = absolute
      hasPosition = true
      _state.update { it.copy(target = absolute, revision = it.revision + 1) }
      saveNow()
      report(ReportEvent.Progress, reported, position, paused = !playing)
      return
    }
    pendingSeek = absolute
    seekJob?.cancel()
    seekJob = scope.launch {
      delay(SEEK_DEBOUNCE_MS)
      val target = pendingSeek ?: return@launch
      pendingSeek = null
      val mine = generation
      val stamp = ++sequence
      val id = sessionId ?: return@launch
      val descriptor = runCatching { api.seekPlayback(id, target) }.getOrElse { error ->
        if (mine == generation && isDead(error)) onDeadSession()
        return@launch
      }
      if (stopped || mine != generation || stamp != sequence) return@launch
      // The server kept the stream it had: the player must not move, and the position stays put.
      if (descriptor.seekRestored && descriptor.id == id && descriptor.url == _state.value.url) {
        _state.update { it.copy(seekKept = it.seekKept + 1) }
        return@launch
      }
      apply(descriptor, target = target)
      lastPosition = target - offset
      hasPosition = true
      saveNow()
      report(ReportEvent.Progress, reported, position, paused = !playing)
    }
  }

  /** A chosen audio track: selected in ExoPlayer for direct play, or converted by the server. */
  fun selectAudio(index: Int) {
    if (stopped || sessionId == null) return
    val track = audioTracks.getOrNull(index) ?: return
    when (audioRoute(mode, track, capabilities)) {
      AudioRoute.Direct -> setAudioLocal(index)
      // A conversion restart must not take an app-drawn addon subtitle with it: the server is told
      // to drop its own subtitle, and the app keeps drawing the addon it already has.
      AudioRoute.Server -> track(TrackChange.Audio(index, position, subtitleOff = _state.value.subtitle is SubtitleChoice.Addon), addon = currentAddon())
    }
  }

  /**
   * Another source of the same title. A source switch is a new session: the outgoing one is saved
   * and deleted before the new one starts, at the absolute position the viewer is watching.
   */
  fun switchSource(
    sourceId: String,
    subtitles: List<AddonSubtitleDto> = plan?.subtitles ?: emptyList(),
    /** The tracks in effect travel by default: a switch keeps what the viewer is watching. */
    trackChoice: TrackPreferences = trackPreferences(),
  ) {
    if (released) return
    val current = plan ?: return
    val at = restartPosition
    restartAt = at
    AppLog.info("Source switch", mapOf("source" to sourceId))
    begin(
      current.copy(
        sourceId = sourceId,
        explicitTime = at,
        resume = false,
        subtitles = subtitles,
        trackChoice = trackChoice,
        mint = null,
      ),
    )
  }

  /**
   * A chosen picture height, or Original. Original after a forced conversion cannot be undone
   * inside the session -- the server never copies that source again -- so it starts a new one.
   */
  fun selectQuality(quality: Int?) {
    if (stopped || sessionId == null) return
    val row = when (quality) {
      null -> QualityChoice.Original
      1080 -> QualityChoice.P1080
      720 -> QualityChoice.P720
      480 -> QualityChoice.P480
      else -> return
    }
    // The row that is already ticked only closes the panel; re-running the same conversion would
    // restart the picture for nothing.
    if (qualityChoice(this.quality, escalatedByViewer) == row) return
    if (quality == null && escalated) {
      val current = plan ?: return
      val at = restartPosition
      restartAt = at
      begin(current.copy(explicitTime = at, resume = false, carrySubtitle = _state.value.subtitle))
      return
    }
    track(TrackChange.Quality(quality, position), addon = null)
  }

  /** A chosen subtitle row. The four cases live in [subtitleRoute] and [subtitleNeedsServer]. */
  fun selectSubtitle(choice: SubtitleChoice) {
    if (stopped || sessionId == null) return
    val embedded = (choice as? SubtitleChoice.Embedded)?.let { subtitleTracks.getOrNull(it.index) }
    val route = subtitleRoute(mode, embedded, addon = choice is SubtitleChoice.Addon, capabilities = capabilities)
    val server = subtitleNeedsServer(_state.value.sidecarUrl != null, route)
    val addon = (choice as? SubtitleChoice.Addon)?.let { picked -> _state.value.addonSubtitles.firstOrNull { it.subtitleId == picked.subtitleId } }
    if (!server) {
      setSubtitleLocal(choice)
      return
    }
    val index = (choice as? SubtitleChoice.Embedded)?.index
    track(TrackChange.Subtitle(index, position), addon = addon)
  }

  private fun setAudioLocal(index: Int) {
    if (index == _state.value.audioTrackIndex) return
    _state.update { it.copy(audioTrackIndex = index, trackRevision = it.trackRevision + 1) }
  }

  private fun setSubtitleLocal(choice: SubtitleChoice) {
    subtitle = choice
    _state.update { it.copy(subtitle = choice, trackRevision = it.trackRevision + 1) }
  }

  /** One `/track` round trip; the answer is kept only when it is still the current generation. */
  private fun track(request: TrackChange, addon: AddonSubtitleDto?) {
    val id = sessionId ?: return
    AppLog.info("Track switch", mapOf("change" to request.javaClass.simpleName))
    val mine = generation
    val stamp = ++sequence
    // A seek that has been asked for but not answered yet is the position the viewer wants; a track
    // change in that window must carry it, or the server restarts at the stale position.
    val change = request.withTime(pendingSeek ?: position)
    val before = change.time
    trackJob?.cancel()
    trackJob = scope.launch {
      val descriptor = runCatching { api.trackPlayback(id, change) }.getOrElse { error ->
        if (mine == generation && isDead(error)) onDeadSession()
        return@launch
      }
      if (stopped || mine != generation || stamp != sequence) return@launch
      val sameItem = descriptor.url == _state.value.url && modeOf(descriptor.mode) == mode
      // A subtitle-only answer to the same item left the picture where it was: in direct play the
      // audio was chosen inside ExoPlayer, so the server's descriptor still names its own default
      // and must not re-tick the panel. Every restart answer re-derives the choice.
      val keepAudio = change is TrackChange.Subtitle && sameItem
      apply(descriptor, target = before, bumpRevision = !sameItem, addon = addon, keepAudio = keepAudio, subtitleChange = change is TrackChange.Subtitle)
      lastPosition = before - offset
    }
  }

  /** The addon subtitle the viewer is watching, so a conversion restart can keep it. */
  private fun currentAddon(): AddonSubtitleDto? {
    val chosen = _state.value.subtitle as? SubtitleChoice.Addon ?: return null
    return _state.value.addonSubtitles.firstOrNull { it.subtitleId == chosen.subtitleId }
  }

  fun onDecoderError() {
    if (stopped || sessionId == null) return
    val id = sessionId ?: return
    val position = position
    if (escalated) {
      AppLog.error("Player decoder error", mapOf("fatal" to "true"))
      _state.update { it.copy(error = PlaybackError.Decoder) }
      return
    }
    AppLog.warn("Player decoder error, escalating")
    escalated = true
    val mine = generation
    scope.launch {
      val descriptor = runCatching { api.escalatePlayback(id, position) }.getOrNull()
      if (stopped || mine != generation) return@launch
      if (descriptor != null) apply(descriptor, target = position)
      else _state.update { it.copy(error = PlaybackError.Decoder) }
    }
  }

  /**
   * The viewer asked for a real conversion. The server stops copying this session for good, so the
   * only way back to a copy is a new session; a failure here is a decoder error like any other.
   */
  fun escalate() {
    if (stopped || sessionId == null) return
    val id = sessionId ?: return
    val at = position
    val mine = generation
    AppLog.info("Escalated by viewer", mapOf("source" to (sourceId ?: "")))
    escalated = true
    escalatedByViewer = true
    scope.launch {
      val descriptor = runCatching { api.escalatePlayback(id, at) }.getOrNull()
      if (stopped || mine != generation) return@launch
      if (descriptor != null) apply(descriptor, target = at)
      else _state.update { it.copy(error = PlaybackError.Decoder) }
    }
  }

  fun onNetworkError() {
    AppLog.error("Player network error", mapOf("source" to (sourceId ?: "")))
    _state.update { it.copy(error = PlaybackError.Network) }
  }

  /** A session the server has forgotten: restart once at the absolute position, else give up. */
  private fun onDeadSession() {
    if (recovered) {
      AppLog.error("Playback session lost")
      _state.update { it.copy(error = PlaybackError.Session) }
      return
    }
    recovered = true
    retry()
  }

  /** Leaving the player: a final save, then the delete. Both are best-effort and never throw. */
  fun stop() {
    if (stopped) return
    stopped = true
    AppLog.info("Session stop", mapOf("source" to (sourceId ?: "")))
    restartAt = null
    // Superseding an in-flight start makes it delete its own session once it lands.
    generation++
    cancelLoops()
    val id = sessionId
    val outgoingReported = reported
    val outgoingPosition = position
    reported = null
    val payload = if (hasPosition) SavePayload(key, position, duration, title, path, poster, addonKey, remote, stableKey) else null
    sessionId = null
    if (outgoingReported != null) report(ReportEvent.Stop, outgoingReported, outgoingPosition, paused = !playing)
    if (payload != null || id != null) {
      scope.launch {
        if (payload != null) runCatching { save(payload) }
        if (id != null) runCatching { api.deletePlayback(id) }
      }
    }
  }

  /** The screen is gone: release the session and refuse any start or retry that answers late. */
  fun release() {
    released = true
    stop()
  }

  private fun saveNow() {
    if (stopped || !hasPosition || sessionId == null) return
    val payload = SavePayload(key, position, duration, title, path, poster, addonKey, remote, stableKey)
    scope.launch { runCatching { save(payload) } }
  }

  /** The remote identity of the current session, or the one an outgoing save carries. */
  private fun remoteApi(): RemoteLibraryApi =
    api as? RemoteLibraryApi
      ?: throw ApiError(ApiFailure.Generic)

  /**
   * A native remote play of a title the catalogue can name stores its position on the title's own
   * key, naming the version that wrote it. A version nothing can name keeps the local remote-state
   * endpoint, and everything else keeps the generic progress route it always had.
   */
  private suspend fun save(payload: SavePayload) {
    val context = payload.remote
    if (context != null && !VersionProgress.titleOwned(payload.key, context)) {
      remoteApi().patchRemoteItemState(
        context.libraryId,
        context.itemId,
        RemoteItemStatePatch(position = payload.position, duration = payload.duration, mediaSourceId = context.mediaSourceId),
      )
      return
    }
    api.saveProgress(payload.key, payload.position, payload.duration, payload.title, payload.path, payload.poster, payload.addonKey, remote = context, stableKey = payload.stableKey)
  }

  private fun startLoops() {
    val id = sessionId ?: return
    pingJob = scope.launch {
      while (isActive) {
        delay(PING_INTERVAL_MS)
        try {
          api.pingPlayback(id)
          _state.update { it.copy(lastPingAt = clock()) }
        } catch (error: Throwable) {
          if (isDead(error)) {
            if (generation == currentGenerationFor(id)) onDeadSession()
            return@launch
          }
        }
      }
    }
    saveJob = scope.launch {
      while (isActive) {
        delay(SAVE_INTERVAL_MS)
        if (playing && hasPosition) runCatching { save(SavePayload(key, position, duration, title, path, poster, addonKey, remote, stableKey)) }
      }
    }
    reportJob = scope.launch {
      while (isActive) {
        delay(REPORT_INTERVAL_MS)
        report(ReportEvent.Progress, reported, position, paused = !playing)
      }
    }
  }

  /** The ping loop's session id is only still ours when the generation has not moved on. */
  private fun currentGenerationFor(id: String): Int = if (sessionId == id) generation else -1

  private fun cancelLoops() {
    pingJob?.cancel(); pingJob = null
    saveJob?.cancel(); saveJob = null
    reportJob?.cancel(); reportJob = null
    seekJob?.cancel(); seekJob = null
    trackJob?.cancel(); trackJob = null
    pendingSeek = null
  }

  private fun deleteSession(id: String) {
    scope.launch { runCatching { api.deletePlayback(id) } }
  }

  /** A report is best-effort: playback never waits for it and never learns that it failed. */
  private fun report(event: ReportEvent, context: RemoteItemContext?, position: Double, paused: Boolean) {
    val remote = context ?: return
    if (VersionProgress.writer(remote) == null) return
    scope.launch { sendReport(event, remote, position, paused) }
  }

  private suspend fun sendReport(event: ReportEvent, context: RemoteItemContext, position: Double, paused: Boolean) {
    val writer = VersionProgress.writer(context) ?: return
    reportLock.withLock {
      try {
        (api as? RemoteLibraryApi)?.reportRemotePlayback(
          writer.first,
          writer.second,
          RemotePlaybackReport(
            mediaSourceId = writer.third,
            position = round(position).toLong().coerceAtLeast(0L),
            paused = paused,
            event = event.wire,
          ),
        )
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: Throwable) {
      }
    }
  }

  private fun apply(
    descriptor: PlaybackDescriptorDto,
    target: Double,
    plan: StartPlan? = null,
    bumpRevision: Boolean = true,
    addon: AddonSubtitleDto? = null,
    keepAudio: Boolean = false,
    /** True only for a `/track` answer to a subtitle the viewer picked. */
    subtitleChange: Boolean = false,
  ) {
    sessionId = descriptor.id
    restartAt = null
    playlist = descriptor.playlist
    offset = descriptor.offset
    duration = descriptor.duration ?: duration
    mode = modeOf(descriptor.mode)
    val priorMode = _state.value.mode
    if (!_state.value.started || mode != priorMode) AppLog.info("Playback path", mapOf("mode" to mode.name))
    copyAudio = descriptor.copy?.audio ?: true
    copyVideo = descriptor.copy?.video ?: true
    quality = descriptor.quality
    audioTracks = descriptorTracks(descriptor.audioTracks)
    subtitleTracks = descriptorTracks(descriptor.subtitleTracks)
    // The server's descriptor never names an app-drawn addon, so a seek, a quality or audio change,
    // an escalate or a dead-session restart keeps the client's choice; only a subtitle answer or a
    // fresh session re-derives it.
    val carried = plan?.carrySubtitle
    val chosen = when {
      addon != null -> SubtitleChoice.Addon(addon.subtitleId)
      subtitleChange -> descriptor.subtitleTrack?.let { SubtitleChoice.Embedded(it) } ?: SubtitleChoice.Off
      // Only the app-drawn addon is the client's to keep: an embedded track is the server's, and
      // a restarted session's answer says which one the picture now carries.
      carried is SubtitleChoice.Addon -> carried
      plan != null -> descriptor.subtitleTrack?.let { SubtitleChoice.Embedded(it) } ?: SubtitleChoice.Off
      else -> _state.value.subtitle
    }
    recovered = false
    lastPosition = target - offset
    val addons = plan?.subtitles ?: _state.value.addonSubtitles
    val defaultAddon = if (!subtitleChange && addon == null && carried == null && descriptor.subtitleTrack == null && descriptor.sidecarUrl == null) {
      plan?.let { defaultAddon(it, descriptor, addons) }
    } else null
    val shown = defaultAddon?.let { SubtitleChoice.Addon(it.subtitleId) } ?: chosen
    subtitle = shown
    val audioChoice = if (keepAudio) _state.value.audioTrackIndex else descriptor.audioTrack.coerceIn(0, maxOf(0, audioTracks.size - 1))
    val currentSourceId = sourceId
    _state.update {
      it.copy(
        loading = false,
        started = true,
        url = descriptor.url,
        playlist = playlist,
        offset = offset,
        duration = duration,
        mode = mode,
        copyAudio = copyAudio,
        copyVideo = copyVideo,
        quality = quality,
        escalatedByViewer = escalatedByViewer,
        audioTracks = audioTracks,
        audioTrackIndex = audioChoice,
        subtitleTracks = subtitleTracks,
        subtitle = shown,
        sidecarUrl = descriptor.sidecarUrl,
        addonSubtitles = addons,
        subtitleIds = descriptor.subtitleIds.ifEmpty { it.subtitleIds },
        videoCodec = descriptor.video,
        audioCodec = descriptor.audio,
        sourceId = currentSourceId,
        target = target,
        revision = if (bumpRevision) it.revision + 1 else it.revision,
        trackRevision = it.trackRevision + 1,
        error = null,
      )
    }
  }

  /** The addon fills only a gap the file left, by the viewer's own choice when the session carries
   *  one and by the account's language otherwise, the way the web does. */
  private fun defaultAddon(plan: StartPlan, descriptor: PlaybackDescriptorDto, addons: List<AddonSubtitleDto>): AddonSubtitleDto? {
    val choice = plan.trackChoice
    // The viewer turned subtitles off, so nothing may turn one back on behind their back.
    if (choice?.subtitleOff == true) return null
    val preferred = choice?.subtitle ?: plan.subtitlePreference ?: return null
    val spoken = audioTracks.getOrNull(descriptor.audioTrack.coerceIn(0, maxOf(0, audioTracks.size - 1)))?.language
    // A viewer who was reading this subtitle keeps it whatever the sound is; "the audio is already
    // in a language they know" is the account's own rule, and it governs only an automatic pick.
    val understood = if (choice != null) null else plan.audioPreference
    return Languages.pickAddonSubtitle(addons, preferred, spoken, understood)
  }

  private fun modeOf(value: String): PlaybackMode = when (value) {
    "remux" -> PlaybackMode.Remux
    "transcode" -> PlaybackMode.Transcode
    else -> PlaybackMode.Direct
  }

  private fun isDead(error: Throwable): Boolean = (error as? ApiError)?.failure == ApiFailure.NotFound

  private fun errorOf(error: Throwable): PlaybackError {
    val failure = (error as? ApiError)?.failure
    return when (failure) {
      ApiFailure.SessionExpired, ApiFailure.Forbidden -> PlaybackError.Session
      else -> PlaybackError.Network
    }
  }

  private data class SavePayload(
    val key: String,
    val position: Double,
    val duration: Double,
    val title: String,
    val path: String?,
    val poster: String?,
    val addonKey: String?,
    /** Null for the generic progress route; set to store on the local remote-state endpoint. */
    val remote: RemoteItemContext?,
    /** The stable handle of the row the position was played from. */
    val stableKey: String?,
  )

  companion object {
    const val PING_INTERVAL_MS = 30_000L
    const val SAVE_INTERVAL_MS = 10_000L
    const val REPORT_INTERVAL_MS = 10_000L
    const val SEEK_DEBOUNCE_MS = 600L
    /** The server refuses a start with more than a hundred subtitle ids. */
    const val MAX_SUBTITLE_IDS = 100
  }
}

/** Whether a subtitle change needs the server: whenever the old or the new source is one the
 *  server reads itself. A direct-to-direct switch never leaves the player. */
fun subtitleNeedsServer(currentServer: Boolean, next: SubtitleRoute): Boolean =
  currentServer || next == SubtitleRoute.EmbeddedServer

/** The same change, carrying the position the viewer actually asked for. */
private fun TrackChange.withTime(time: Double): TrackChange = when (this) {
  is TrackChange.Audio -> copy(time = time)
  is TrackChange.Subtitle -> copy(time = time)
  is TrackChange.Quality -> copy(time = time)
}

/** The Quality panel's rows, re-derived from the answered descriptor. */
enum class QualityChoice { Original, P1080, P720, P480, Force }

/**
 * Which row the Quality panel ticks. A chosen height wins; otherwise only the viewer's own
 * escalate is the forced conversion. A transcode the server chose for another reason -- a burned
 * in subtitle, an audio track it cannot copy -- is still the server's own choice (Original).
 */
fun qualityChoice(quality: Int?, escalatedByViewer: Boolean): QualityChoice = when {
  quality == 1080 -> QualityChoice.P1080
  quality == 720 -> QualityChoice.P720
  quality == 480 -> QualityChoice.P480
  escalatedByViewer -> QualityChoice.Force
  else -> QualityChoice.Original
}
