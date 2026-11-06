@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import android.content.Context
import android.os.Looper
import java.time.Duration
import org.robolectric.Shadows.shadowOf
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
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
import cz.stremiooffline.tv.data.NextFileDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.playback.CatalogueNext
import cz.stremiooffline.tv.playback.Progress
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Bugs on the emulator: a film that played to its end left the player on its last frame instead
 * of handing the screen back to the detail; after the next episode started on its own the remote
 * was dead, because the card that held the focus went away with nothing to take it; and a
 * catalogue episode never offered the next one. ExoPlayer here plays fake media to its real end.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerScreenEndTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  /** A stream whose URL says `long` plays for an hour, `mid` for fifteen seconds, any other for one. */
  private class FakeMedia : MediaSource.Factory {
    override fun setDrmSessionManagerProvider(provider: DrmSessionManagerProvider) = this
    override fun setLoadErrorHandlingPolicy(policy: LoadErrorHandlingPolicy) = this
    override fun getSupportedTypes(): IntArray = intArrayOf()
    override fun createMediaSource(mediaItem: MediaItem): MediaSource {
      val uri = mediaItem.localConfiguration?.uri?.toString().orEmpty()
      val durationUs = when {
        "long" in uri -> 3_600_000_000L
        "mid" in uri -> 15_000_000L
        else -> 1_000_000L
      }
      return FakeMediaSource(
        FakeTimeline(FakeTimeline.TimelineWindowDefinition(1, mediaItem, true, false, durationUs)),
        ExoPlayerTestRunner.VIDEO_FORMAT,
      )
    }
  }

  private val fakePlayer: (Context, OkHttpClient) -> ExoPlayer = { context, _ ->
    TestExoPlayerBuilder(context).setMediaSourceFactory(FakeMedia()).build()
  }

  /** The player's own clock moves with the main looper's, so both are walked forward together. */
  private fun playUntil(timeoutMs: Long = 20_000, condition: () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (!condition()) {
      check(System.currentTimeMillis() < deadline) { "Condition still not satisfied after $timeoutMs ms" }
      shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
      compose.mainClock.advanceTimeBy(100)
      Thread.sleep(10)
    }
    compose.waitForIdle()
  }

  private fun nextCardShown() = compose.onAllNodes(hasTestTag(TagNextCard)).fetchSemanticsNodes().isNotEmpty()

  private val api = FakeTvApi()

  @Test
  fun `a film that plays to its end hands the screen back`() {
    api.startAnswer = PlaybackDescriptorDto(id = "p1", url = "/film.mp4", duration = 1.0)
    var exited = false
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(key = "movie:tt1", title = "Film", resume = false, sourceId = "film"),
        onExit = { exited = true },
        createPlayer = fakePlayer,
      )
    }

    playUntil { exited }
    assertEquals(listOf("p1"), api.deletedIds)
  }

  @Test
  fun `the next episode that starts on its own leaves the remote working`() {
    api.libraryNextValue = NextFileDto(path = "Show/E2.mkv", title = "Show · E2")
    api.startAnswers["src:Show/E1.mkv"] = PlaybackDescriptorDto(id = "p1", url = "/e1-mid.mp4", duration = 15.0)
    api.startAnswers["src:Show/E2.mkv"] = PlaybackDescriptorDto(id = "p2", url = "/e2-long.mp4", duration = 3600.0)
    var exited = false
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(key = Progress.libraryKey("Show/E1.mkv"), title = "Show · E1", resume = false, path = "Show/E1.mkv"),
        onExit = { exited = true },
        createPlayer = fakePlayer,
      )
    }

    // Back hides the OSD, the way it is hidden when the episode runs out on the sofa.
    playUntil { api.startedSources.isNotEmpty() }
    compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()
    compose.onNodeWithTag(TAG_OSD_PLAY).assertDoesNotExist()
    playUntil { nextCardShown() }
    playUntil { api.startedSources.size == 2 }
    assertEquals(false, exited)

    compose.onNode(isFocused()).assertExists()
    compose.onNode(isFocused()).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.onNodeWithTag(TAG_OSD_PLAY).assertExists()
    compose.onNodeWithText("Show · E2").assertExists()
  }

  @Test
  fun `the last episode of a library series hands the screen back`() {
    api.startAnswers["src:Show/E3.mkv"] = PlaybackDescriptorDto(id = "p3", url = "/e3.mp4", duration = 1.0)
    var exited = false
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(key = Progress.libraryKey("Show/E3.mkv"), title = "Show · E3", resume = false, path = "Show/E3.mkv"),
        onExit = { exited = true },
        createPlayer = fakePlayer,
      )
    }

    playUntil { exited }
    assertEquals(listOf("src:Show/E3.mkv"), api.libraryNextRequests)
  }

  @Test
  fun `a catalogue episode offers the next one the detail picks and plays it in place`() {
    api.startAnswers["e1"] = PlaybackDescriptorDto(id = "p1", url = "/e1.mp4", duration = 1.0)
    api.startAnswers["e2"] = PlaybackDescriptorDto(id = "p2", url = "/e2-long.mp4", duration = 3600.0)
    val first = PlayTarget(
      key = "series:tt9:1:1",
      title = "Show · First",
      resume = false,
      sourceId = "e1",
      subtitleType = "series",
      subtitleTarget = "tt9:1:1",
      catalogue = true,
    )
    val second = first.copy(key = "series:tt9:1:2", title = "Show · Second", sourceId = "e2", subtitleTarget = "tt9:1:2")
    var advanced = 0
    var next by mutableStateOf<PlayTarget?>(null)
    var exited = false
    compose.setContent {
      PlayerScreen(
        api = api,
        target = first,
        onExit = { exited = true },
        catalogueNext = CatalogueNext("Show · Second") { advanced++; next = second },
        nextTarget = next,
        onNextTargetTaken = { next = null },
        createPlayer = fakePlayer,
      )
    }

    playUntil { nextCardShown() }
    compose.onNodeWithText("Show · Second").assertExists()
    playUntil { api.startedSources == listOf("e1", "e2") }
    compose.waitForIdle()

    assertEquals(1, advanced)
    assertEquals(false, exited)
    assertEquals(listOf("p1"), api.deletedIds)
    compose.onNodeWithText("Show · Second").assertExists()
  }
}
