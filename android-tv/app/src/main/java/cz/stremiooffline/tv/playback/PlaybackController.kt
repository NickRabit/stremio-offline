package cz.stremiooffline.tv.playback

import cz.stremiooffline.tv.catalog.Languages
import cz.stremiooffline.tv.data.AddonSubtitleDto
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.ClientCapabilitiesDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.TrackChange
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** The playback calls of one server, taken straight off [cz.stremiooffline.tv.data.ApiClient]. */
interface PlaybackApi {
  suspend fun startPlayback(
    sourceId: String,
    capabilities: ClientCapabilitiesDto,
    time: Double,
    subtitleIds: List<String> = emptyList(),
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
  private var audioTracks: List<DescriptorTrack> = emptyList()
  private var subtitleTracks: List<DescriptorTrack> = emptyList()
  private var subtitle: SubtitleChoice = SubtitleChoice.Off

  private var key = ""
  private var title = ""
  private var path: String? = null
  private var poster: String? = null
  private var addonKey: String? = null

  private data class StartPlan(
    val sourceId: String,
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
  )

  private var plan: StartPlan? = null

  private var playing = false
  private var ready = false
  private var hasPosition = false
  private var lastPosition = 0.0
  private var escalated = false
  private var recovered = false
  private var stopped = true

  private var pingJob: Job? = null
  private var saveJob: Job? = null
  private var seekJob: Job? = null
  private var trackJob: Job? = null
  private var pendingSeek: Double? = null
  private var sequence = 0
  /** Bumped by every start and stop, so a late answer from a superseded request is dropped. */
  private var generation = 0

  /** The absolute position, converted through the HLS offset the way the spec defines it. */
  val position: Double get() = absolute(lastPosition)

  private fun absolute(playerPosition: Double) = if (playlist) offset + playerPosition else playerPosition

  private fun startPlan(
    sourceId: String,
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
  ) = StartPlan(sourceId, key, title, path, explicitTime, resume, poster, addonKey, subtitles, audioPreference, subtitlePreference, library = path != null)

  fun start(
    sourceId: String,
    key: String,
    title: String,
    path: String?,
    resume: Boolean,
    poster: String? = null,
    addonKey: String? = null,
    subtitles: List<AddonSubtitleDto> = emptyList(),
    audioPreference: String? = null,
    subtitlePreference: String? = null,
  ) = begin(startPlan(sourceId, key, title, path, null, resume, poster, addonKey, subtitles, audioPreference, subtitlePreference))

  /** Starts the next library file: the old session is saved and deleted before the new start. */
  fun playNext(sourceId: String, key: String, title: String, path: String?, resume: Boolean, poster: String? = null) {
    val current = plan ?: return
    begin(startPlan(sourceId, key, title, path, null, resume, poster, current.addonKey, current.subtitles, current.audioPreference, current.subtitlePreference))
  }

  /** Retries a failed start at the position the player last reported. */
  fun retry() {
    val current = plan ?: return
    begin(current.copy(explicitTime = position, resume = false))
  }

  private fun begin(next: StartPlan) {
    val mine = ++generation
    // A start that is still in flight is left to finish: the session it may have already created
    // on the server is deleted when its answer arrives, rather than leaked to the reaper.
    cancelLoops()
    val previousId = sessionId
    val previous = if (previousId != null && hasPosition) SavePayload(key, position, duration, title, path, poster, addonKey) else null
    sessionId = null
    plan = next
    sourceId = next.sourceId
    key = next.key
    title = next.title
    path = next.path
    poster = next.poster
    addonKey = next.addonKey
    playing = false
    ready = false
    hasPosition = false
    lastPosition = 0.0
    escalated = false
    recovered = false
    stopped = false
    playlist = false
    offset = 0.0
    duration = 0.0
    copyAudio = true
    mode = PlaybackMode.Direct
    audioTracks = emptyList()
    subtitleTracks = emptyList()
    subtitle = SubtitleChoice.Off
    _state.value = PlaybackState(loading = true, startedAt = clock())
    scope.launch {
      // The outgoing session is closed first, in one coroutine, so the save and the delete are
      // seen before the new start rather than raced with it.
      if (previous != null) runCatching { save(previous) }
      if (previousId != null) runCatching { api.deletePlayback(previousId) }
      if (mine != generation) return@launch
      val resumeTime = next.explicitTime ?: if (next.resume) storedResumeTime(next.key) else 0.0
      if (mine != generation) return@launch
      if (resumeTime > 0) lastPosition = resumeTime
      val offered = next.subtitles.map { it.subtitleId }.take(MAX_SUBTITLE_IDS)
      val descriptor = runCatching { api.startPlayback(next.sourceId, capabilities, resumeTime, offered) }.getOrElse { error ->
        if (mine == generation) _state.update { it.copy(loading = false, error = errorOf(error)) }
        return@launch
      }
      if (mine != generation) {
        deleteSession(descriptor.id)
        return@launch
      }
      apply(descriptor, target = resumeTime, plan = next)
      startLoops()
    }
  }

  private suspend fun storedResumeTime(key: String): Double {
    val stored = runCatching { api.progress(key) }.getOrNull() ?: return 0.0
    return Progress.resumePosition(stored.position, stored.duration) ?: 0.0
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
    playing = true
  }

  fun onPaused() {
    playing = false
    saveNow()
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
        if (isDead(error)) onDeadSession()
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
    }
  }

  /** A chosen audio track: selected in ExoPlayer for direct play, or converted by the server. */
  fun selectAudio(index: Int) {
    if (stopped || sessionId == null) return
    val track = audioTracks.getOrNull(index) ?: return
    when (audioRoute(mode, track, capabilities)) {
      AudioRoute.Direct -> setAudioLocal(index)
      AudioRoute.Server -> track(TrackChange.Audio(index, position), addon = null)
    }
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
  private fun track(change: TrackChange, addon: AddonSubtitleDto?) {
    val id = sessionId ?: return
    val mine = generation
    val stamp = ++sequence
    val before = position
    trackJob?.cancel()
    trackJob = scope.launch {
      val descriptor = runCatching { api.trackPlayback(id, change) }.getOrElse { error ->
        if (mine == generation && isDead(error)) onDeadSession()
        return@launch
      }
      if (stopped || mine != generation || stamp != sequence) return@launch
      val sameItem = descriptor.url == _state.value.url && modeOf(descriptor.mode) == mode
      apply(descriptor, target = before, bumpRevision = !sameItem, addon = addon)
      lastPosition = before - offset
    }
  }

  fun onDecoderError() {
    if (stopped || sessionId == null) return
    val id = sessionId ?: return
    val position = position
    if (escalated) {
      _state.update { it.copy(error = PlaybackError.Decoder) }
      return
    }
    escalated = true
    val mine = generation
    scope.launch {
      val descriptor = runCatching { api.escalatePlayback(id, position) }.getOrNull()
      if (stopped || mine != generation) return@launch
      if (descriptor != null) apply(descriptor, target = position)
      else _state.update { it.copy(error = PlaybackError.Decoder) }
    }
  }

  fun onNetworkError() {
    _state.update { it.copy(error = PlaybackError.Network) }
  }

  /** A session the server has forgotten: restart once at the absolute position, else give up. */
  private fun onDeadSession() {
    if (recovered) {
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
    // Superseding an in-flight start makes it delete its own session once it lands.
    generation++
    cancelLoops()
    val id = sessionId
    val payload = if (hasPosition) SavePayload(key, position, duration, title, path, poster, addonKey) else null
    sessionId = null
    if (payload != null || id != null) {
      scope.launch {
        if (payload != null) runCatching { save(payload) }
        if (id != null) runCatching { api.deletePlayback(id) }
      }
    }
  }

  private fun saveNow() {
    if (stopped || !hasPosition || sessionId == null) return
    val payload = SavePayload(key, position, duration, title, path, poster, addonKey)
    scope.launch { runCatching { save(payload) } }
  }

  private suspend fun save(payload: SavePayload) {
    api.saveProgress(payload.key, payload.position, payload.duration, payload.title, payload.path, payload.poster, payload.addonKey)
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
        if (playing && hasPosition) runCatching { save(SavePayload(key, position, duration, title, path, poster, addonKey)) }
      }
    }
  }

  /** The ping loop's session id is only still ours when the generation has not moved on. */
  private fun currentGenerationFor(id: String): Int = if (sessionId == id) generation else -1

  private fun cancelLoops() {
    pingJob?.cancel(); pingJob = null
    saveJob?.cancel(); saveJob = null
    seekJob?.cancel(); seekJob = null
    trackJob?.cancel(); trackJob = null
    pendingSeek = null
  }

  private fun deleteSession(id: String) {
    scope.launch { runCatching { api.deletePlayback(id) } }
  }

  private fun apply(
    descriptor: PlaybackDescriptorDto,
    target: Double,
    plan: StartPlan? = null,
    bumpRevision: Boolean = true,
    addon: AddonSubtitleDto? = null,
  ) {
    sessionId = descriptor.id
    playlist = descriptor.playlist
    offset = descriptor.offset
    duration = descriptor.duration ?: duration
    mode = modeOf(descriptor.mode)
    copyAudio = descriptor.copy?.audio ?: true
    audioTracks = descriptorTracks(descriptor.audioTracks)
    subtitleTracks = descriptorTracks(descriptor.subtitleTracks)
    val chosen = when {
      addon != null -> SubtitleChoice.Addon(addon.subtitleId)
      descriptor.subtitleTrack != null -> SubtitleChoice.Embedded(descriptor.subtitleTrack)
      else -> SubtitleChoice.Off
    }
    subtitle = chosen
    recovered = false
    lastPosition = target - offset
    val addons = plan?.subtitles ?: _state.value.addonSubtitles
    val defaultAddon = if (addon == null && descriptor.subtitleTrack == null && descriptor.sidecarUrl == null) {
      plan?.let { defaultAddon(it, descriptor, addons) }
    } else null
    val shown = defaultAddon?.let { SubtitleChoice.Addon(it.subtitleId) } ?: chosen
    subtitle = shown
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
        audioTracks = audioTracks,
        audioTrackIndex = descriptor.audioTrack.coerceIn(0, maxOf(0, audioTracks.size - 1)),
        subtitleTracks = subtitleTracks,
        subtitle = shown,
        sidecarUrl = descriptor.sidecarUrl,
        addonSubtitles = addons,
        subtitleIds = descriptor.subtitleIds.ifEmpty { it.subtitleIds },
        videoCodec = descriptor.video,
        audioCodec = descriptor.audio,
        target = target,
        revision = if (bumpRevision) it.revision + 1 else it.revision,
        trackRevision = it.trackRevision + 1,
        error = null,
      )
    }
  }

  /** The addon fills only a gap the file left, by the account's language, the way the web does. */
  private fun defaultAddon(plan: StartPlan, descriptor: PlaybackDescriptorDto, addons: List<AddonSubtitleDto>): AddonSubtitleDto? {
    val preferred = plan.subtitlePreference ?: return null
    val spoken = audioTracks.getOrNull(descriptor.audioTrack.coerceIn(0, maxOf(0, audioTracks.size - 1)))?.language
    return Languages.pickAddonSubtitle(addons, preferred, spoken, plan.audioPreference)
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
  )

  companion object {
    const val PING_INTERVAL_MS = 30_000L
    const val SAVE_INTERVAL_MS = 10_000L
    const val SEEK_DEBOUNCE_MS = 600L
    /** The server refuses a start with more than a hundred subtitle ids. */
    const val MAX_SUBTITLE_IDS = 100
  }
}

/** Whether a subtitle change needs the server: whenever the old or the new source is one the
 *  server reads itself. A direct-to-direct switch never leaves the player. */
fun subtitleNeedsServer(currentServer: Boolean, next: SubtitleRoute): Boolean =
  currentServer || next == SubtitleRoute.EmbeddedServer
