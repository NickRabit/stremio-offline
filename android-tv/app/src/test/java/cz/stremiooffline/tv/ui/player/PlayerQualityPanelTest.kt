@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import androidx.activity.ComponentActivity
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.CopyDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.data.TrackChange
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Quality and conversion panel: it opens on the choice in use, a height really transcodes, and
 * the forced conversion switches the path the eyebrow names.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerQualityPanelTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private fun mount(api: FakeTvApi) {
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(key = "movie:tt1", title = "It", resume = false, sourceId = "src1"),
        onExit = {},
      )
    }
    compose.waitForIdle()
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  /** Right from Play reaches Quality: Tracks, then Quality (no sources for this title). */
  private fun openQuality() {
    press(Key.DirectionRight)
    press(Key.DirectionRight)
    press(Key.DirectionRight)
    compose.onNodeWithTag(TAG_OSD_QUALITY).assertIsFocused().assert(SemanticsMatcher.expectValue(OsdFocused, true))
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagQualityPanel).assertExists()
  }

  @Test
  fun `the panel opens with the server's own choice focused`() {
    mount(FakeTvApi())

    openQuality()

    compose.onNodeWithTag(qualityRowTag("original")).assertIsFocused()
    compose.onNodeWithText("Convert on the server").assertExists()
    compose.onNodeWithText("Use when the picture or sound plays badly. The server re-encodes the video.").assertExists()
  }

  // Bug on the emulator: the server transcodes only because the account's subtitle is burned in,
  // and the button wrongly named the forced conversion the viewer never asked for.
  @Test
  fun `a subtitle driven transcode still names the server's own choice`() {
    val api = FakeTvApi()
    api.startAnswer = PlaybackDescriptorDto(
      id = "p1",
      mode = "transcode",
      url = "/stream.m3u8",
      playlist = true,
      copy = CopyDto(video = false, audio = false),
      quality = null,
    )
    mount(api)

    compose.onNodeWithTag(TAG_OSD_QUALITY).assertTextContains("Original")

    openQuality()

    compose.onNodeWithTag(qualityRowTag("original")).assertIsFocused()
    compose.onNodeWithTag(qualityRowTag("force")).assertExists()
  }

  @Test
  fun `720p sends the track at the absolute position and ticks the new choice`() {
    val api = FakeTvApi()
    api.trackAnswer = PlaybackDescriptorDto(
      id = "p1",
      mode = "transcode",
      url = "720.m3u8",
      playlist = true,
      copy = CopyDto(video = false, audio = true),
      quality = 720,
    )
    mount(api)

    openQuality()
    press(Key.DirectionDown)
    press(Key.DirectionDown)
    compose.onNodeWithTag(qualityRowTag("720")).assertIsFocused()
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagQualityPanel).assertDoesNotExist()
    assertEquals(1, api.trackChanges.size)
    assertEquals(TrackChange.Quality(720, 0.0), api.trackChanges.last())
    // The button names the choice the answered descriptor re-derived.
    compose.onNodeWithTag(TAG_OSD_QUALITY).assertTextContains("720p")
  }

  @Test
  fun `Convert on the server escalates once and the eyebrow names the new path`() {
    val api = FakeTvApi()
    mount(api)

    openQuality()
    repeat(4) { press(Key.DirectionDown) }
    compose.onNodeWithTag(qualityRowTag("force")).assertIsFocused()
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagQualityPanel).assertDoesNotExist()
    assertEquals(1, api.escalatedTimes.size)
    compose.onNodeWithText("Converted on the server").assertExists()
  }
}
