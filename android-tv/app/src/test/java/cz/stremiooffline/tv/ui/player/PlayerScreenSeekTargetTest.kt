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
import java.io.IOException
import java.time.Duration
import java.util.concurrent.CountDownLatch
import kotlinx.coroutines.CompletableDeferred
import okhttp3.OkHttpClient
import org.junit.After
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
    val released = CountDownLatch(1)

    // A playlist session hands the player an HLS source of its own, so the fake media factory is
    // bypassed and the player would fetch the playlist over the real network. When that lookup
    // failed was up to the runner's DNS, and a failure before the presses put the error over the
    // player, which swallows the D-pad. The request is parked instead, so nothing but the test
    // moves the screen.
    override val http: OkHttpClient = OkHttpClient.Builder()
      .addInterceptor {
        released.await()
        throw IOException("test finished")
      }
      .build()

    override suspend fun seekPlayback(id: String, time: Double): PlaybackDescriptorDto {
      val descriptor = super.seekPlayback(id, time)
      answer.await()
      return descriptor
    }
  }

  @After
  fun releaseParkedRequests() {
    api.released.countDown()
  }

  /** Every step moves both fake clocks, so the bound is fake time, not the runner's speed. */
  private fun advanceUntil(condition: () -> Boolean) {
    repeat(MAX_STEPS) {
      if (condition()) return
      advance(STEP_MS)
    }
    check(condition()) { "Condition still not satisfied after ${MAX_STEPS * STEP_MS} ms of fake time" }
  }

  private fun advance(milliseconds: Long) {
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(milliseconds))
    compose.mainClock.advanceTimeBy(milliseconds)
    compose.waitForIdle()
  }

  private fun waitForPosition(text: String) {
    compose.onNodeWithTag(TAG_SEEK_STRIP_POSITION, useUnmergedTree = true).assertTextEquals(text)
  }

  private val api = SeekApi()

  @Test
  fun `dpad bursts keep the unanswered target on the timeline and accumulate from it`() {
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

  private companion object {
    const val STEP_MS = 100L
    const val MAX_STEPS = 50
  }
}
