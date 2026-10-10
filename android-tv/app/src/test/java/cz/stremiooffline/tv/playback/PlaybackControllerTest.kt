package cz.stremiooffline.tv.playback

import cz.stremiooffline.tv.data.ClientCapabilitiesDto
import cz.stremiooffline.tv.data.CopyDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.TrackChange
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackControllerTest {

  private val capabilities = ClientCapabilitiesDto(
    h264 = true,
    containers = listOf("mp4", "mkv", "webm", "ts"),
    audioDecode = listOf("ac3"),
  )

  private class FakeApi : PlaybackApi {
    val started = mutableListOf<Triple<String, ClientCapabilitiesDto, Double>>()
    val seeks = mutableListOf<Double>()
    val escalates = mutableListOf<Double>()
    val pings = mutableListOf<String>()
    val deleted = mutableListOf<String>()
    val saved = mutableListOf<Pair<String, Double>>()
    /** Every mutating call in the order it arrived, so a stop's save-then-delete is visible. */
    val calls = mutableListOf<String>()

    var stored: ProgressDto? = null
    var failSave = false
    var failStart = false
    var startDelayMs = 0L
    var descriptor = PlaybackDescriptorDto(id = "p1", mode = "direct", url = "direct.mp4", offset = 0.0, duration = 1_000.0)

    val subtitleIds = mutableListOf<List<String>>()

    override suspend fun startPlayback(
      sourceId: String,
      capabilities: ClientCapabilitiesDto,
      time: Double,
      subtitleIds: List<String>,
    ): PlaybackDescriptorDto {
      calls += "start"
      started += Triple(sourceId, capabilities, time)
      this.subtitleIds += subtitleIds
      if (startDelayMs > 0) delay(startDelayMs)
      if (failStart) throw IllegalStateException("the server said no")
      return descriptor
    }

    val tracks = mutableListOf<TrackChange>()
    var trackAnswer: PlaybackDescriptorDto? = null

    override suspend fun trackPlayback(id: String, change: TrackChange): PlaybackDescriptorDto {
      tracks += change
      return trackAnswer ?: descriptor
    }

    override suspend fun seekPlayback(id: String, time: Double): PlaybackDescriptorDto {
      seeks += time
      return descriptor.copy(mode = "remux", url = "playlist-$time.m3u8", offset = time, playlist = true, copy = CopyDto(video = true, audio = true))
    }

    override suspend fun escalatePlayback(id: String, time: Double): PlaybackDescriptorDto {
      escalates += time
      return descriptor.copy(mode = "transcode", url = "transcode.m3u8", offset = time, playlist = true)
    }

    override suspend fun pingPlayback(id: String) {
      pings += id
      pingFailure?.let { throw it }
    }

    var pingFailure: Throwable? = null

    override suspend fun deletePlayback(id: String) {
      calls += "delete"
      deleted += id
    }

    override suspend fun progress(key: String): ProgressDto? = stored

    override suspend fun saveProgress(
      key: String,
      position: Double,
      duration: Double,
      title: String,
      path: String?,
      poster: String?,
      addonKey: String?,
    ) {
      if (failSave) throw IllegalStateException("the server said no")
      calls += "save"
      saved += key to position
    }
  }

  @Test
  fun `start sends the capabilities and the stored resume time`() = runTest {
    val api = FakeApi()
    api.stored = ProgressDto(position = 120.0, duration = 1_000.0)
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    controller.start("src", "file:Films/It.mkv", "It", "Films/It.mkv", resume = true)
    runCurrent()

    assertEquals(1, api.started.size)
    assertEquals("src", api.started[0].first)
    assertEquals(capabilities, api.started[0].second)
    assertEquals(120.0, api.started[0].third, 0.001)
  }

  @Test
  fun `a stored position is not overwritten before the player reports one`() = runTest {
    val api = FakeApi()
    api.stored = ProgressDto(position = 120.0, duration = 1_000.0)
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    controller.start("src", "file:Films/It.mkv", "It", "Films/It.mkv", resume = true)
    runCurrent()
    controller.onPlaying()
    advanceTimeBy(10_001)
    runCurrent()

    assertTrue(api.saved.isEmpty())
  }

  @Test
  fun `pings at thirty and sixty seconds while paused`() = runTest {
    val api = FakeApi()
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    controller.start("src", "file:a", "A", "a", resume = false)
    runCurrent()
    advanceTimeBy(30_001)
    runCurrent()
    assertEquals(1, api.pings.size)
    advanceTimeBy(30_000)
    runCurrent()
    assertEquals(2, api.pings.size)
  }

  @Test
  fun `progress is saved at ten seconds and on pause`() = runTest {
    val api = FakeApi()
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    controller.start("src", "file:a", "A", "a", resume = false)
    runCurrent()
    controller.onPlayerReady()
    controller.onPlayerPosition(10.0)
    controller.onPlaying()
    advanceTimeBy(10_001)
    runCurrent()
    assertEquals(1, api.saved.size)
    assertEquals(10.0, api.saved[0].second, 0.001)

    controller.onPaused()
    runCurrent()
    assertEquals(2, api.saved.size)
  }

  @Test
  fun `an hls seek is debounced and the offset becomes the position`() = runTest {
    val api = FakeApi()
    api.descriptor = PlaybackDescriptorDto(
      id = "p1", mode = "remux", url = "start.m3u8", offset = 0.0, duration = 1_000.0,
      playlist = true, copy = CopyDto(video = true, audio = true),
    )
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    controller.start("src", "file:a", "A", "a", resume = false)
    runCurrent()
    controller.seekTo(100.0)
    controller.seekTo(105.0)
    controller.seekTo(110.0)
    advanceTimeBy(601)
    runCurrent()

    assertEquals(listOf(110.0), api.seeks)
    controller.onPlayerPosition(5.0)
    assertEquals(115.0, controller.position, 0.001)
  }

  @Test
  fun `a direct seek never hits the server`() = runTest {
    val api = FakeApi()
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    controller.start("src", "file:a", "A", "a", resume = false)
    runCurrent()
    controller.onPlayerPosition(20.0)
    controller.seekTo(50.0)
    advanceTimeBy(1_001)
    runCurrent()

    assertTrue(api.seeks.isEmpty())
    assertEquals(50.0, controller.position, 0.001)
  }

  @Test
  fun `stop saves the position and then deletes the session`() = runTest {
    val api = FakeApi()
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    controller.start("src", "file:a", "A", "a", resume = false)
    runCurrent()
    controller.onPlayerReady()
    controller.onPlayerPosition(42.0)
    controller.stop()
    runCurrent()

    assertEquals(1, api.saved.size)
    assertEquals(42.0, api.saved[0].second, 0.001)
    assertEquals(listOf("p1"), api.deleted)
  }

  @Test
  fun `stop still deletes the session when the save fails`() = runTest {
    val api = FakeApi()
    api.failSave = true
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    controller.start("src", "file:a", "A", "a", resume = false)
    runCurrent()
    controller.onPlayerReady()
    controller.onPlayerPosition(42.0)
    controller.stop()
    runCurrent()

    assertEquals(listOf("p1"), api.deleted)
  }

  @Test
  fun `stop after a failed start still deletes the session`() = runTest {
    val api = FakeApi()
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    controller.start("src", "file:a", "A", "a", resume = false)
    runCurrent()
    api.failStart = true
    controller.retry()
    runCurrent()
    controller.stop()
    runCurrent()

    assertEquals(listOf("p1"), api.deleted)
  }

  @Test
  fun `leaving while the start is in flight still deletes the session`() = runTest {
    val api = FakeApi()
    api.startDelayMs = 1_000
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    controller.start("src", "file:a", "A", "a", resume = false)
    runCurrent()
    controller.stop()
    runCurrent()
    advanceTimeBy(1_001)
    runCurrent()

    assertEquals(listOf("p1"), api.deleted)
  }

  @Test
  fun `escalate happens at most once`() = runTest {
    val api = FakeApi()
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    controller.start("src", "file:a", "A", "a", resume = false)
    runCurrent()
    controller.onPlayerPosition(30.0)
    controller.onDecoderError()
    runCurrent()
    controller.onDecoderError()
    runCurrent()

    assertEquals(1, api.escalates.size)
    assertEquals(PlaybackError.Decoder, controller.state.value.error)
  }

  @Test
  fun `closing a still loading resume must not overwrite stored progress`() = runTest {
    val api = FakeApi()
    api.stored = ProgressDto(position = 120.0, duration = 1_000.0)
    api.startDelayMs = 5_000L
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)
    controller.start("src", "file:a", "A", "a", resume = true)
    runCurrent()
    controller.onPlayerPosition(0.0)
    controller.stop()
    runCurrent()
    assertTrue("Opening and closing an unprepared player must preserve resume; saved=${api.saved}", api.saved.isEmpty())
  }

  @Test
  fun `a position the player reported after becoming ready is saved`() = runTest {
    val api = FakeApi()
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    controller.start("src", "file:a", "A", "a", resume = false)
    runCurrent()
    controller.onPlayerReady()
    controller.onPlayerPosition(12.0)
    controller.stop()
    runCurrent()

    assertEquals(listOf(12.0), api.saved.map { it.second })
  }

  @Test
  fun `a refused seek must retain the playing position`() = runTest {
    val api = FakeApi()
    api.descriptor = PlaybackDescriptorDto(id = "p1", mode = "remux", url = "old.m3u8", offset = 0.0, duration = 1_000.0, playlist = true)
    val restoredApi = object : PlaybackApi by api {
      override suspend fun seekPlayback(id: String, time: Double): PlaybackDescriptorDto =
        kotlinx.serialization.json.Json { ignoreUnknownKeys = true }.decodeFromString(
          PlaybackDescriptorDto.serializer(),
          """{"id":"p1","mode":"remux","url":"old.m3u8","offset":0,"duration":1000,"playlist":true,"seekRestored":true}""",
        )
    }
    val controller = PlaybackController(restoredApi, backgroundScope, { 0L }, capabilities)
    controller.start("src", "file:a", "A", "a", resume = false)
    runCurrent()
    controller.onPlayerPosition(100.0)
    controller.seekTo(900.0)
    advanceTimeBy(601L)
    runCurrent()
    assertEquals("The server retained the old stream; the requested position was never reached", 100.0, controller.position, 0.001)
  }

  @Test
  fun `a refused seek asks the screen to show the message`() = runTest {
    val api = FakeApi()
    api.descriptor = PlaybackDescriptorDto(id = "p1", mode = "remux", url = "old.m3u8", offset = 0.0, duration = 1_000.0, playlist = true)
    val restoredApi = object : PlaybackApi by api {
      override suspend fun seekPlayback(id: String, time: Double): PlaybackDescriptorDto =
        api.descriptor.copy(seekRestored = true)
    }
    val controller = PlaybackController(restoredApi, backgroundScope, { 0L }, capabilities)
    controller.start("src", "file:a", "A", "a", resume = false)
    runCurrent()
    controller.onPlayerPosition(100.0)
    controller.seekTo(900.0)
    advanceTimeBy(601L)
    runCurrent()

    assertEquals(1, controller.state.value.seekKept)
  }

  @Test
  fun `coming back from the background stops and starts again at the position left behind`() = runTest {
    val api = FakeApi()
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    controller.start("src", "file:a", "A", "a", resume = true)
    runCurrent()
    controller.onPlayerReady()
    controller.onPlayerPosition(42.0)
    controller.stop()
    runCurrent()
    assertEquals(listOf("start", "save", "delete"), api.calls)

    controller.retry()
    runCurrent()
    assertEquals(listOf("start", "save", "delete", "start"), api.calls)
    assertEquals(42.0, api.started.last().third, 0.001)
    assertTrue("The restart resumes at the position, not from the server's stored value", api.saved.size == 1)
  }

  @Test
  fun `a track answer keeps the absolute position through a regenerated playlist`() = runTest {
    val api = FakeApi()
    api.descriptor = PlaybackDescriptorDto(
      id = "p1", mode = "direct", url = "direct.mp4", offset = 0.0, duration = 600.0,
      audioTracks = tracks("dts"),
    )
    api.trackAnswer = PlaybackDescriptorDto(
      id = "p1", mode = "remux", url = "remux.m3u8", offset = 120.0, duration = 600.0,
      playlist = true, copy = CopyDto(video = true, audio = false), audioTracks = tracks("dts"),
    )
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    controller.start("src", "file:a", "A", "a", resume = false)
    runCurrent()
    controller.onPlayerReady()
    controller.onPlayerPosition(120.0)
    controller.selectAudio(0)
    runCurrent()

    assertEquals(1, api.tracks.size)
    // The server restarted the stream at 120 s; the answer's offset and target keep the picture there.
    assertEquals(120.0, api.tracks.single().let { (it as TrackChange.Audio).time }, 0.001)
    assertEquals(120.0, controller.state.value.target, 0.001)
    assertEquals(120.0, controller.position, 0.001)
  }

  @Test
  fun `starting the next episode saves and deletes the old session before the new start`() = runTest {
    val api = FakeApi()
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    controller.start("src1", "file:a", "A", "a", resume = false)
    runCurrent()
    controller.onPlayerReady()
    controller.onPlayerPosition(300.0)
    api.calls.clear()

    controller.playNext("src2", "file:b", "B", "b", resume = false)
    runCurrent()

    assertEquals(listOf("save", "delete", "start"), api.calls)
    assertEquals("src2", api.started.last().first)
  }

  @Test
  fun `a session the server has forgotten is restarted once at the position`() = runTest {
    val api = FakeApi()
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    controller.start("src", "file:a", "A", "a", resume = false)
    runCurrent()
    controller.onPlayerReady()
    controller.onPlayerPosition(50.0)
    api.pingFailure = ApiError(ApiFailure.NotFound)
    advanceTimeBy(30_001)
    runCurrent()

    assertEquals(2, api.started.size)
    assertEquals(50.0, api.started.last().third, 0.001)
  }

  @Test
  fun `a restart that fails too leaves the error panel`() = runTest {
    val api = FakeApi()
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    controller.start("src", "file:a", "A", "a", resume = false)
    runCurrent()
    controller.onPlayerReady()
    controller.onPlayerPosition(50.0)
    api.pingFailure = ApiError(ApiFailure.NotFound)
    api.failStart = true
    advanceTimeBy(30_001)
    runCurrent()

    assertEquals(PlaybackError.Network, controller.state.value.error)
  }

  private fun tracks(codec: String): List<JsonObject> =
    listOf(Json.parseToJsonElement("""{"index":0,"codec":"$codec"}""").jsonObject)
}
