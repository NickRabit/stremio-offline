@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import android.content.Context
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.drm.DrmSessionManagerProvider
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import androidx.media3.test.utils.ExoPlayerTestRunner
import androidx.media3.test.utils.FakeMediaSource
import androidx.media3.test.utils.FakeTimeline
import androidx.media3.test.utils.TestExoPlayerBuilder
import cz.stremiooffline.tv.data.CopyDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.playback.PlaybackController
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import java.time.Duration
import kotlinx.coroutines.CompletableDeferred
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerScreenSeekTargetTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private class FakeMedia : MediaSource.Factory {
    override fun setDrmSessionManagerProvider(provider: DrmSessionManagerProvider) = this
    override fun setLoadErrorHandlingPolicy(policy: LoadErrorHandlingPolicy) = this
    override fun getSupportedTypes(): IntArray = intArrayOf()
    override fun createMediaSource(mediaItem: MediaItem): MediaSource = FakeMediaSource(
      FakeTimeline(FakeTimeline.TimelineWindowDefinition(1, mediaItem, true, false, 1_000_000_000L)),
      ExoPlayerTestRunner.VIDEO_FORMAT,
    )
  }

  private class SeekApi : FakeTvApi() {
    val answer = CompletableDeferred<Unit>()

    override suspend fun seekPlayback(id: String, time: Double): PlaybackDescriptorDto {
      val descriptor = super.seekPlayback(id, time)
      answer.await()
      return descriptor
    }
  }

  private fun advanceUntil(condition: () -> Boolean) {
    val deadline = System.currentTimeMillis() + 5_000
    while (!condition()) {
      check(System.currentTimeMillis() < deadline) { "Condition still not satisfied after 5000 ms" }
      shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
      compose.mainClock.advanceTimeBy(100)
      compose.waitForIdle()
      Thread.sleep(10)
    }
  }

  private fun advance(milliseconds: Long) {
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(milliseconds))
    compose.mainClock.advanceTimeBy(milliseconds)
    compose.waitForIdle()
  }

  private fun waitForPosition(text: String) {
    compose.onNodeWithTag(TAG_SEEK_STRIP_POSITION, useUnmergedTree = true).assertTextEquals(text)
  }

  @Test
  fun `dpad bursts keep the unanswered target on the timeline and accumulate from it`() {
    val api = SeekApi()
    api.startAnswer = PlaybackDescriptorDto(
      id = "p1",
      mode = "remux",
      url = "/stream.m3u8",
      offset = 0.0,
      duration = 1_000.0,
      playlist = true,
      copy = CopyDto(video = true, audio = true),
    )
    lateinit var player: ExoPlayer
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(key = "movie:tt1", title = "It", resume = false, sourceId = "src1"),
        onExit = {},
        createPlayer = { context: Context, _: OkHttpClient ->
          TestExoPlayerBuilder(context).setMediaSourceFactory(FakeMedia()).build().also { player = it }
        },
      )
    }
    compose.waitUntil(5_000) { api.startedSources.isNotEmpty() }
    compose.runOnUiThread { player.seekTo(100_000) }
    advanceUntil {
      runCatching {
        compose.onNodeWithTag(TAG_OSD_PLAY).assertExists()
      }.isSuccess
    }
    advance(750)

    compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()
    compose.onNodeWithTag(TAG_OSD_PLAY).assertDoesNotExist()

    compose.onNode(isFocused()).performKeyInput { pressKey(Key.DirectionRight) }
    // Read while the strip is still up: the presses have stopped and the overlay has handed the
    // seek over, which is the moment the timeline used to fall back to the old place.
    advance(PlaybackController.SEEK_DEBOUNCE_MS + 100)
    waitForPosition("01:50")
    advanceUntil { api.seekTimes.isNotEmpty() }
    assertEquals(listOf(110.0), api.seekTimes)

    compose.onNode(isFocused()).performKeyInput { pressKey(Key.DirectionRight) }
    advanceUntil { api.seekTimes.size == 2 }
    assertEquals(120.0, api.seekTimes.last(), 0.001)
  }
}
