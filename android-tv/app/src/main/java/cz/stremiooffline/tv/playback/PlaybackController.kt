package cz.stremiooffline.tv.playback

import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.ClientCapabilitiesDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.data.ProgressDto
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
  suspend fun startPlayback(sourceId: String, capabilities: ClientCapabilitiesDto, time: Double): PlaybackDescriptorDto
  suspend fun seekPlayback(id: String, time: Double): PlaybackDescriptorDto
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

/** What the player screen draws. `revision` changes whenever the source must be (re)loaded. */
data class PlaybackState(
  val loading: Boolean = false,
  val started: Boolean = false,
  val url: String? = null,
  val playlist: Boolean = false,
  val offset: Double = 0.0,
  val duration: Double = 0.0,
  val mode: PlaybackMode = PlaybackMode.Direct,
  val copyAudio: Boolean = true,
  /** The server's chosen audio track, for the direct-play override; null when it names none. */
  val audioTrack: DescriptorTrack? = null,
  /** The absolute position the player should start or seek to after `revision` changes. */
  val target: Double = 0.0,
  val revision: Int = 0,
  val startedAt: Long = 0L,
  /** Bumped when the server refused a seek; the screen shows the message for a few seconds. */
  val seekKept: Int = 0,
  val error: PlaybackError? = null,
)

/**
 * The playback session of one title, free of Android types so the whole lifecycle can be
 * unit-tested. It owns the start, the seek debounce, the 30 s ping, the 10 s progress save and
 * the one escalate a decoder error is allowed.
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

  private var key = ""
  private var title = ""
  private var path: String? = null
  private var poster: String? = null
  private var addonKey: String? = null

  private var playing = false
  private var ready = false
  private var hasPosition = false
  private var lastPosition = 0.0
  private var escalated = false
  private var stopped = true

  private var pingJob: Job? = null
  private var saveJob: Job? = null
  private var seekJob: Job? = null
  private var pendingSeek: Double? = null
  private var sequence = 0
  /** Bumped by every start and stop, so a late answer from a superseded request is dropped. */
  private var generation = 0

  /** The absolute position, converted through the HLS offset the way the spec defines it. */
  val position: Double get() = absolute(lastPosition)

  private fun absolute(playerPosition: Double) = if (playlist) offset + playerPosition else playerPosition

  fun start(
    sourceId: String,
    key: String,
    title: String,
    path: String?,
    resume: Boolean,
    poster: String? = null,
    addonKey: String? = null,
  ) = begin(sourceId, key, title, path, explicitTime = null, resume = resume, poster = poster, addonKey = addonKey)

  /** Retries a failed start at the position the player last reported. */
  fun retry() {
    val id = sourceId ?: return
    begin(id, key, title, path, explicitTime = position, resume = false, poster = poster, addonKey = addonKey)
  }

  private fun begin(
    sourceId: String,
    key: String,
    title: String,
    path: String?,
    explicitTime: Double?,
    resume: Boolean,
    poster: String?,
    addonKey: String?,
  ) {
    val mine = ++generation
    // A start that is still in flight is left to finish: the session it may have already created
    // on the server is deleted when its answer arrives, rather than leaked to the reaper.
    cancelLoops()
    val previous = sessionId
    sessionId = null
    if (previous != null) deleteSession(previous)
    this.sourceId = sourceId
    this.key = key
    this.title = title
    this.path = path
    this.poster = poster
    this.addonKey = addonKey
    playing = false
    ready = false
    hasPosition = false
    lastPosition = 0.0
    escalated = false
    stopped = false
    playlist = false
    offset = 0.0
    duration = 0.0
    copyAudio = true
    mode = PlaybackMode.Direct
    _state.value = PlaybackState(loading = true, startedAt = clock())
    scope.launch {
      val resumeTime = explicitTime ?: if (resume) storedResumeTime(key) else 0.0
      if (mine != generation) return@launch
      if (resumeTime > 0) lastPosition = resumeTime
      val descriptor = runCatching { api.startPlayback(sourceId, capabilities, resumeTime) }.getOrElse { error ->
        if (mine == generation) _state.update { it.copy(loading = false, error = errorOf(error)) }
        return@launch
      }
      if (mine != generation) {
        deleteSession(descriptor.id)
        return@launch
      }
      apply(descriptor, target = resumeTime)
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
      val descriptor = runCatching { api.seekPlayback(id, target) }.getOrNull() ?: return@launch
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
        if (payload != null) runCatching {
          api.saveProgress(payload.key, payload.position, payload.duration, payload.title, payload.path, payload.poster, payload.addonKey)
        }
        if (id != null) runCatching { api.deletePlayback(id) }
      }
    }
  }

  private fun saveNow() {
    if (stopped || !hasPosition || sessionId == null) return
    val position = position
    val duration = duration
    val key = key
    val title = title
    val path = path
    val poster = poster
    val addonKey = addonKey
    scope.launch { runCatching { api.saveProgress(key, position, duration, title, path, poster, addonKey) } }
  }

  private fun startLoops() {
    val id = sessionId ?: return
    pingJob = scope.launch {
      while (isActive) {
        delay(PING_INTERVAL_MS)
        runCatching { api.pingPlayback(id) }
      }
    }
    saveJob = scope.launch {
      while (isActive) {
        delay(SAVE_INTERVAL_MS)
        if (playing && hasPosition) runCatching { api.saveProgress(key, position, duration, title, path, poster, addonKey) }
      }
    }
  }

  private fun cancelLoops() {
    pingJob?.cancel(); pingJob = null
    saveJob?.cancel(); saveJob = null
    seekJob?.cancel(); seekJob = null
    pendingSeek = null
  }

  private fun deleteSession(id: String) {
    scope.launch { runCatching { api.deletePlayback(id) } }
  }

  private fun apply(descriptor: PlaybackDescriptorDto, target: Double) {
    sessionId = descriptor.id
    playlist = descriptor.playlist
    offset = descriptor.offset
    duration = descriptor.duration ?: duration
    mode = modeOf(descriptor.mode)
    copyAudio = descriptor.copy?.audio ?: true
    lastPosition = target - offset
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
        audioTrack = descriptorTrack(descriptor.audioTracks, descriptor.audioTrack),
        target = target,
        revision = it.revision + 1,
        error = null,
      )
    }
  }

  private fun modeOf(value: String): PlaybackMode = when (value) {
    "remux" -> PlaybackMode.Remux
    "transcode" -> PlaybackMode.Transcode
    else -> PlaybackMode.Direct
  }

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
  }
}
