package cz.stremiooffline.tv.playback

import cz.stremiooffline.tv.data.ClientCapabilitiesDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteItemStateDto
import cz.stremiooffline.tv.data.RemoteLibraryApi
import cz.stremiooffline.tv.data.TrackChange
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

/** A native remote play reads its position from the local remote-state store, never the progress
 *  route, and only for the version it stored: a watched item never offers a resume. */
class RemoteResumeTest {

  private val capabilities = ClientCapabilitiesDto(
    h264 = true,
    containers = listOf("mkv"),
    audioDecode = listOf("ac3"),
  )

  private class FakeApi(private val stored: RemoteItemStateDto) : PlaybackApi, RemoteLibraryApi {
    val startedTimes = mutableListOf<Double>()

    override suspend fun startPlayback(
      sourceId: String,
      capabilities: ClientCapabilitiesDto,
      time: Double,
      subtitleIds: List<String>,
    ): PlaybackDescriptorDto {
      startedTimes += time
      return PlaybackDescriptorDto(id = "p1", url = "direct.mp4")
    }

    override suspend fun seekPlayback(id: String, time: Double): PlaybackDescriptorDto =
      PlaybackDescriptorDto(id = id, url = "direct.mp4")

    override suspend fun trackPlayback(id: String, change: TrackChange): PlaybackDescriptorDto =
      PlaybackDescriptorDto(id = id, url = "direct.mp4")

    override suspend fun escalatePlayback(id: String, time: Double): PlaybackDescriptorDto =
      PlaybackDescriptorDto(id = id, url = "direct.mp4")

    override suspend fun pingPlayback(id: String) {}

    override suspend fun deletePlayback(id: String) {}

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
    ) {}

    override suspend fun remoteItemState(libraryId: String, itemId: String): RemoteItemStateDto = stored
  }

  private fun context(mediaSourceId: String) = RemoteItemContext(
    libraryId = "rlibA",
    itemId = "iA",
    mediaSourceId = mediaSourceId,
    progressKey = "remote:rlibA:iA",
  )

  @Test
  fun `a watched remote item starts at zero even for the same version`() = runTest {
    val api = FakeApi(RemoteItemStateDto(position = 120.0, duration = 1_000.0, watched = true, mediaSourceId = "ms1"))
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    controller.start(
      sourceId = "src",
      key = "remote:rlibA:iA",
      title = "It",
      path = null,
      resume = true,
      remoteItem = context("ms1"),
    )
    runCurrent()

    assertEquals(listOf(0.0), api.startedTimes)
  }

  @Test
  fun `an unwatched remote item of the same version still resumes`() = runTest {
    val api = FakeApi(RemoteItemStateDto(position = 120.0, duration = 1_000.0, watched = false, mediaSourceId = "ms1"))
    val controller = PlaybackController(api, backgroundScope, { 0L }, capabilities)

    controller.start(
      sourceId = "src",
      key = "remote:rlibA:iA",
      title = "It",
      path = null,
      resume = true,
      remoteItem = context("ms1"),
    )
    runCurrent()

    assertEquals(listOf(120.0), api.startedTimes)
  }
}
