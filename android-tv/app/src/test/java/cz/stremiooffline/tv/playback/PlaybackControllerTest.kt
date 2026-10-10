package cz.stremiooffline.tv.playback

import cz.stremiooffline.tv.data.ClientCapabilitiesDto
import cz.stremiooffline.tv.data.CopyDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.data.ProgressDto
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

    var stored: ProgressDto? = null
    var failSave = false
    var failStart = false
    var startDelayMs = 0L
    var descriptor = PlaybackDescriptorDto(id = "p1", mode = "direct", url = "direct.mp4", offset = 0.0, duration = 1_000.0)

    override suspend fun startPlayback(sourceId: String, capabilities: ClientCapabilitiesDto, time: Double): PlaybackDescriptorDto {
      started += Triple(sourceId, capabilities, time)
      if (startDelayMs > 0) delay(startDelayMs)
      if (failStart) throw IllegalStateException("the server said no")
      return descriptor
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
    }

    override suspend fun deletePlayback(id: String) {
      deleted += id
    }

    override suspend fun progress(key: String): ProgressDto? = stored

    override suspend fun saveProgress(key: String, position: Double, duration: Double, title: String, path: String?) {
      if (failSave) throw IllegalStateException("the server said no")
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
}
