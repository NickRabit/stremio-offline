package cz.stremiooffline.tv.playback

import cz.stremiooffline.tv.data.ClientCapabilitiesDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteItemStateDto
import cz.stremiooffline.tv.data.RemoteItemStatePatch
import cz.stremiooffline.tv.data.RemoteLibraryApi
import cz.stremiooffline.tv.data.RemotePlaybackReport
import cz.stremiooffline.tv.data.TrackChange
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A native remote play tells the media server it is playing, moving, paused or gone. */
class RemotePlaybackReportTest {
  private val playIdPattern = Regex("^[0-9a-f]{32}$")

  private val capabilities = ClientCapabilitiesDto(
    h264 = true,
    containers = listOf("mkv"),
    audioDecode = listOf("ac3"),
  )

  private val context = RemoteItemContext(
    libraryId = "rlibA",
    itemId = "iA",
    mediaSourceId = "ms1",
    progressKey = "remote:rlibA:iA",
  )

  private class FakeApi(
    private val stored: RemoteItemStateDto = RemoteItemStateDto(),
    private val failReport: Boolean = false,
    private val progressDelayMs: Long = 0L,
  ) : PlaybackApi, RemoteLibraryApi {
    val reports = mutableListOf<Triple<String, String, RemotePlaybackReport>>()
    val deleted = mutableListOf<String>()
    val saves = mutableListOf<String>()
    val patches = mutableListOf<RemoteItemStatePatch>()
    var reportAttempts = 0
    var starts = 0

    override suspend fun startPlayback(
      sourceId: String,
      capabilities: ClientCapabilitiesDto,
      time: Double,
      subtitleIds: List<String>,
      audioLanguage: String?,
      subtitleLanguage: String?,
      subtitleOff: Boolean,
    ): PlaybackDescriptorDto {
      starts += 1
      return PlaybackDescriptorDto(id = "p$starts", url = "direct.mp4", duration = 1_000.0)
    }

    override suspend fun seekPlayback(id: String, time: Double): PlaybackDescriptorDto =
      PlaybackDescriptorDto(id = id, url = "direct.mp4")

    override suspend fun trackPlayback(id: String, change: TrackChange): PlaybackDescriptorDto =
      PlaybackDescriptorDto(id = id, url = "direct.mp4")

    override suspend fun escalatePlayback(id: String, time: Double): PlaybackDescriptorDto =
      PlaybackDescriptorDto(id = id, url = "direct.mp4")

    override suspend fun pingPlayback(id: String) {}

    override suspend fun deletePlayback(id: String) {
      deleted += id
    }

    override suspend fun progress(key: String): ProgressDto? = null

    override suspend fun saveProgress(
      key: String,
      position: Double,
      duration: Double,
      title: String,
      path: String?,
      poster: String?,
      addonKey: String?,
      remote: RemoteItemContext?,
      stableKey: String?,
    ) {
      saves += key
    }

    override suspend fun remoteItemState(libraryId: String, itemId: String): RemoteItemStateDto = stored

    override suspend fun patchRemoteItemState(
      libraryId: String,
      itemId: String,
      patch: RemoteItemStatePatch,
    ): RemoteItemStateDto {
      patches += patch
      return stored
    }

    override suspend fun reportRemotePlayback(libraryId: String, itemId: String, report: RemotePlaybackReport) {
      reportAttempts += 1
      if (report.event == "progress" && progressDelayMs > 0) delay(progressDelayMs)
      if (failReport) throw IllegalStateException("the server said no")
      reports += Triple(libraryId, itemId, report)
    }
  }

  private fun remoteStart(controller: PlaybackController, remote: RemoteItemContext = context) {
    controller.start(
      sourceId = "src",
      key = remote.progressKey,
      title = "It",
      path = null,
      resume = true,
      remoteItem = remote,
    )
  }

  @Test
  fun `a remote play reports one start at its resume position`() = runTest {
    val api = FakeApi(RemoteItemStateDto(position = 120.0, duration = 1_000.0, mediaSourceId = "ms1"))
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    remoteStart(controller)
    runCurrent()

    val (libraryId, itemId, report) = api.reports.single()
    assertEquals("rlibA", libraryId)
    assertEquals("iA", itemId)
    assertEquals("ms1", report.mediaSourceId)
    assertEquals(120L, report.position)
    assertEquals(true, report.paused)
    assertEquals("start", report.event)
    assertTrue(playIdPattern.matches(report.playId!!))
  }

  @Test
  fun `progress follows the interval and every playing change`() = runTest {
    val api = FakeApi()
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    remoteStart(controller)
    runCurrent()
    controller.onPlayerReady()
    controller.onPlayerPosition(130.0)
    advanceTimeBy(10_001)
    runCurrent()

    assertEquals("progress", api.reports.last().third.event)
    assertEquals(130L, api.reports.last().third.position)
    assertEquals(true, api.reports.last().third.paused)

    controller.onPlaying()
    runCurrent()
    assertEquals("progress", api.reports.last().third.event)
    assertEquals(false, api.reports.last().third.paused)
    assertEquals(api.reports.first().third.playId, api.reports.last().third.playId)

    controller.onPaused()
    runCurrent()
    assertEquals("progress", api.reports.last().third.event)
    assertEquals(true, api.reports.last().third.paused)

    val count = api.reports.size
    controller.onPaused()
    runCurrent()
    assertEquals(count, api.reports.size)
    assertEquals(1, api.reports.mapNotNull { it.third.playId }.distinct().size)
  }

  @Test
  fun `a direct seek reports the new position`() = runTest {
    val api = FakeApi()
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    remoteStart(controller)
    runCurrent()
    controller.onPlayerReady()
    controller.onPlayerPosition(0.0)
    controller.seekTo(120.0)
    runCurrent()

    assertEquals("progress", api.reports.last().third.event)
    assertEquals(120L, api.reports.last().third.position)
  }

  @Test
  fun `stop reports once and nothing follows it`() = runTest {
    val api = FakeApi()
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    remoteStart(controller)
    runCurrent()
    controller.onPlayerReady()
    controller.onPlayerPosition(42.0)
    controller.stop()
    runCurrent()

    assertEquals("stop", api.reports.last().third.event)
    assertEquals(42L, api.reports.last().third.position)
    assertEquals(1, api.reports.count { it.third.event == "stop" })
    assertEquals(api.reports.first().third.playId, api.reports.last().third.playId)

    val count = api.reports.size
    controller.stop()
    advanceTimeBy(30_000)
    runCurrent()
    assertEquals(count, api.reports.size)
  }

  @Test
  fun `a source switch stops the old version before starting the new one`() = runTest {
    val api = FakeApi()
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    remoteStart(controller)
    runCurrent()
    controller.onPlayerReady()
    controller.onPlayerPosition(300.0)
    val next = context.copy(mediaSourceId = "ms2")

    controller.start(
      sourceId = "src2",
      key = next.progressKey,
      title = "It",
      path = null,
      resume = false,
      at = 300.0,
      remoteItem = next,
    )
    runCurrent()

    assertEquals(
      listOf("start" to "ms1", "stop" to "ms1", "start" to "ms2"),
      api.reports.map { it.third.event to it.third.mediaSourceId },
    )
    assertEquals(300L, api.reports[1].third.position)
    val oldPlayId = api.reports[0].third.playId
    assertTrue(playIdPattern.matches(oldPlayId!!))
    assertEquals(oldPlayId, api.reports[1].third.playId)
    assertTrue(playIdPattern.matches(api.reports[2].third.playId!!))
    assertNotEquals(oldPlayId, api.reports[2].third.playId)
  }

  @Test
  fun `a play without a remote context reports nothing`() = runTest {
    val api = FakeApi()
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    controller.start("src", "file:a", "A", "a", resume = false)
    runCurrent()
    advanceTimeBy(30_000)
    controller.onPlaying()
    controller.seekTo(120.0)
    controller.stop()
    runCurrent()

    assertTrue(api.reports.isEmpty())
  }

  @Test
  fun `a failing report never changes playback or its teardown`() = runTest {
    val api = FakeApi(failReport = true)
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    remoteStart(controller)
    runCurrent()

    assertEquals(1, api.reportAttempts)
    assertNotNull(controller.state.value.url)
    assertNull(controller.state.value.error)

    controller.onPlayerReady()
    controller.onPlayerPosition(30.0)
    controller.stop()
    runCurrent()
    assertTrue(api.patches.isNotEmpty())
    assertEquals(listOf("p1"), api.deleted)
  }

  @Test
  fun `a slow progress still reaches the server before the stop`() = runTest {
    val api = FakeApi(progressDelayMs = 2_000)
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    remoteStart(controller)
    runCurrent()
    controller.onPlayerReady()
    controller.onPlayerPosition(10.0)
    controller.onPlaying()
    runCurrent()
    controller.stop()
    advanceTimeBy(5_000)
    runCurrent()

    assertEquals(listOf("start", "progress", "stop"), api.reports.map { it.third.event })
  }
}
