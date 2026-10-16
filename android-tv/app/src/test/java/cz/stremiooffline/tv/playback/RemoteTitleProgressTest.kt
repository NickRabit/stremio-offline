package cz.stremiooffline.tv.playback

import cz.stremiooffline.tv.data.ClientCapabilitiesDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteItemStateDto
import cz.stremiooffline.tv.data.RemoteItemStatePatch
import cz.stremiooffline.tv.data.RemoteLibraryApi
import cz.stremiooffline.tv.data.TrackChange
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A media-server version of a title the catalogue can name reads and writes the title's own key:
 * any version of the title resumes the one position, and the outgoing save names the version that
 * wrote it. A version nothing can name keeps the item's own remote state, unchanged.
 */
class RemoteTitleProgressTest {

  private val capabilities = ClientCapabilitiesDto(
    h264 = true,
    containers = listOf("mkv"),
    audioDecode = listOf("ac3"),
  )

  private val context = RemoteItemContext(libraryId = "lib", itemId = "item", mediaSourceId = "v1", progressKey = "remote:abc")

  private class FakeApi(
    private val title: ProgressDto?,
    private val own: RemoteItemStateDto,
  ) : PlaybackApi, RemoteLibraryApi {
    val startedTimes = mutableListOf<Double>()
    /** Every title key the resume asked for, in order. */
    val readKeys = mutableListOf<String>()
    val stateReads = mutableListOf<Pair<String, String>>()
    val savedKeys = mutableListOf<String>()
    val savedRemotes = mutableListOf<RemoteItemContext?>()
    val patches = mutableListOf<RemoteItemStatePatch>()

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

    override suspend fun progress(key: String): ProgressDto? {
      readKeys += key
      return title
    }

    override suspend fun saveProgress(
      key: String,
      position: Double,
      duration: Double,
      title: String,
      path: String?,
      poster: String?,
      addonKey: String?,
      remote: RemoteItemContext?,
    ) {
      savedKeys += key
      savedRemotes += remote
    }

    override suspend fun remoteItemState(libraryId: String, itemId: String): RemoteItemStateDto {
      stateReads += libraryId to itemId
      return own
    }

    override suspend fun patchRemoteItemState(
      libraryId: String,
      itemId: String,
      patch: RemoteItemStatePatch,
    ): RemoteItemStateDto {
      patches += patch
      return own
    }
  }

  private fun controller(api: FakeApi, scope: CoroutineScope) = PlaybackController(api, scope, { 0L }, capabilities)

  private fun start(controller: PlaybackController, key: String, resume: Boolean) {
    controller.start(sourceId = "src", key = key, title = "The Matrix", path = null, resume = resume, remoteItem = context)
  }

  /** The title's own row decides the position, whichever version stored it. */
  @Test
  fun `a media-server version of a nameable title resumes the title's own row`() = runTest {
    val api = FakeApi(ProgressDto(position = 1200.0, duration = 7200.0), RemoteItemStateDto())
    val controller = controller(api, backgroundScope)

    start(controller, "movie:tt0133093", resume = true)
    runCurrent()

    assertEquals(listOf(1200.0), api.startedTimes)
    assertEquals(listOf("movie:tt0133093"), api.readKeys)
    // The title answered, so the item's own state was never read.
    assertTrue(api.stateReads.isEmpty())
  }

  /** No media-source guard on the title's own row: any version of the title resumes it. */
  @Test
  fun `a title row written by another version still resumes this one`() = runTest {
    val api = FakeApi(
      ProgressDto(position = 1200.0, duration = 7200.0),
      RemoteItemStateDto(position = 300.0, duration = 7200.0, mediaSourceId = "v2"),
    )
    val controller = controller(api, backgroundScope)

    start(controller, "movie:tt0133093", resume = true)
    runCurrent()

    assertEquals(listOf(1200.0), api.startedTimes)
  }

  /** A position stored before the title held it stays resumable, with today's guard. */
  @Test
  fun `a title key with no row falls back to the item's own state of the same version`() = runTest {
    val api = FakeApi(null, RemoteItemStateDto(position = 900.0, duration = 7200.0, mediaSourceId = "v1"))
    val controller = controller(api, backgroundScope)

    start(controller, "movie:tt0133093", resume = true)
    runCurrent()

    assertEquals(listOf(900.0), api.startedTimes)
    assertEquals(listOf("movie:tt0133093"), api.readKeys)
    assertEquals(listOf("lib" to "item"), api.stateReads)
  }

  /** Another version's stored position is another version's, exactly as it was. */
  @Test
  fun `a fallback row of another version starts from the beginning`() = runTest {
    val api = FakeApi(null, RemoteItemStateDto(position = 900.0, duration = 7200.0, mediaSourceId = "v2"))
    val controller = controller(api, backgroundScope)

    start(controller, "movie:tt0133093", resume = true)
    runCurrent()

    assertEquals(listOf(0.0), api.startedTimes)
  }

  /** A title-owned save writes the title's key, names the version and never patches the item. */
  @Test
  fun `a pause writes the title's key and names the version that wrote it`() = runTest {
    val api = FakeApi(ProgressDto(position = 1200.0, duration = 7200.0), RemoteItemStateDto())
    val controller = controller(api, backgroundScope)

    start(controller, "movie:tt0133093", resume = false)
    runCurrent()
    controller.onPlayerReady()
    controller.onPlayerPosition(600.0)
    controller.onPaused()
    runCurrent()

    assertEquals(listOf("movie:tt0133093"), api.savedKeys)
    assertEquals(listOf(context), api.savedRemotes)
    assertTrue(api.patches.isEmpty())
  }

  /** A version no title names keeps the item's own store on both sides. */
  @Test
  fun `a version without an identity reads and writes the item's own state`() = runTest {
    val api = FakeApi(ProgressDto(position = 1200.0, duration = 7200.0), RemoteItemStateDto(position = 900.0, duration = 7200.0, mediaSourceId = "v1"))
    val controller = controller(api, backgroundScope)

    start(controller, "remote:abc", resume = true)
    runCurrent()

    assertEquals(listOf(900.0), api.startedTimes)
    assertTrue(api.readKeys.isEmpty())
    assertEquals(listOf("lib" to "item"), api.stateReads)

    controller.onPlayerReady()
    controller.onPlayerPosition(600.0)
    controller.onPaused()
    runCurrent()

    assertEquals(1, api.patches.size)
    assertEquals(600.0, api.patches.single().position ?: -1.0, 0.001)
    assertEquals("v1", api.patches.single().mediaSourceId)
    assertTrue(api.savedKeys.isEmpty())
  }
}
