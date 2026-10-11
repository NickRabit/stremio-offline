@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.isFocusable
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.requestFocus
import cz.stremiooffline.tv.data.AddonSubtitleDto
import cz.stremiooffline.tv.data.ClientCapabilitiesDto
import cz.stremiooffline.tv.playback.DescriptorTrack
import cz.stremiooffline.tv.playback.SubtitleChoice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerTracksPanelTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private val capabilities = ClientCapabilitiesDto(audioDecode = listOf("aac"), audioPassthrough = listOf("eac3"), subtitles = listOf("subrip"))
  private val audio = listOf(
    DescriptorTrack(index = 0, language = "en", codec = "aac", channels = 2),
    DescriptorTrack(index = 1, language = "cs", codec = "eac3", channels = 6),
  )
  private val embedded = listOf(DescriptorTrack(index = 0, language = "en", codec = "subrip"))
  private val addons = listOf(AddonSubtitleDto(subtitleId = "sid", lang = "cs", addonName = "OpenSubtitles"))

  private var audioCalls = mutableListOf<Int>()
  private var subtitleCalls = mutableListOf<SubtitleChoice>()
  private var delayCalls = mutableListOf<Double>()
  private var closes = 0

  private fun mount(subtitle: SubtitleChoice = SubtitleChoice.Embedded(0), delayEnabled: Boolean = true) {
    compose.setContent {
      PlayerTracksPanel(
        audioTracks = audio,
        audioTrackIndex = 1,
        subtitleTracks = embedded,
        subtitle = subtitle,
        addonSubtitles = addons,
        capabilities = capabilities,
        delay = 0.0,
        delayEnabled = delayEnabled,
        onAudio = { audioCalls += it },
        onSubtitle = { subtitleCalls += it },
        onDelay = { delayCalls += it },
        onClose = { closes += 1 },
      )
    }
  }

  @Test
  fun `the panel lists audio, subtitles and the addon with the current choices ticked`() {
    mount()

    compose.onNodeWithTag(TagTracksPanel).assertIsDisplayed()
    compose.onNodeWithTag(audioRowTag(0)).assertExists()
    compose.onNodeWithTag(audioRowTag(1)).assertIsSelected()
    compose.onNodeWithTag(TagSubtitleOffRow).assertExists()
    compose.onNodeWithTag(embeddedRowTag(0)).assertIsSelected()
    compose.onNodeWithTag(addonRowTag(0)).assertExists()
    // The capability of each audio track is spelled out.
    compose.onNodeWithText("CZ · eac3 · 5.1 · passthrough to the receiver").assertExists()
  }

  @Test
  fun `OK on an audio row asks for it and the subtitle rows ask for their choice`() {
    mount()

    compose.onNodeWithTag(audioRowTag(0)).requestFocus()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    assertEquals(listOf(0), audioCalls)

    compose.onNodeWithTag(addonRowTag(0)).requestFocus()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    assertEquals(listOf<SubtitleChoice>(SubtitleChoice.Addon("sid")), subtitleCalls)
  }

  @Test
  fun `LEFT and RIGHT on the delay row move it by a quarter of a second`() {
    mount()

    compose.onNodeWithTag(TagDelayRow).requestFocus()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionRight) }
    compose.onRoot().performKeyInput { pressKey(Key.DirectionLeft) }
    compose.waitForIdle()

    assertEquals(listOf(0.25, -0.25), delayCalls)
  }

  @Test
  fun `the delay row is disabled while the client draws the embedded track itself`() {
    mount(delayEnabled = false)

    assertTrue(compose.onAllNodes(hasTestTag(TagDelayRow) and isFocusable()).fetchSemanticsNodes().isEmpty())
    compose.onNodeWithText("Delay works for server and addon subtitles.").assertExists()
  }

  // Same bug as the OSD buttons: the row wrote `onFocusChanged` after `focusable()`, so its
  // focused background never drew.
  @Test
  fun `the delay row shows it holds the remote`() {
    mount()

    compose.onNodeWithTag(TagDelayRow).requestFocus()
    compose.waitForIdle()

    compose.onNodeWithTag(TagDelayRow).assert(SemanticsMatcher.expectValue(OsdFocused, true))
  }

  @Test
  fun `a title with no audio draws one non-focusable dash`() {
    compose.setContent {
      PlayerTracksPanel(
        audioTracks = emptyList(),
        audioTrackIndex = 0,
        subtitleTracks = emptyList(),
        subtitle = SubtitleChoice.Off,
        addonSubtitles = emptyList(),
        capabilities = capabilities,
        delay = 0.0,
        delayEnabled = false,
        onAudio = {},
        onSubtitle = {},
        onDelay = {},
        onClose = {},
      )
    }
    compose.onNodeWithTag(audioRowTag(0)).assertDoesNotExist()
    compose.onNodeWithText(DIAGNOSTIC_UNKNOWN).assertExists()
  }

  @Test
  fun `several releases of one language are numbered so the rows can be told apart`() {
    compose.setContent {
      PlayerTracksPanel(
        audioTracks = emptyList(),
        audioTrackIndex = 0,
        subtitleTracks = emptyList(),
        subtitle = SubtitleChoice.Off,
        addonSubtitles = listOf(
          AddonSubtitleDto(subtitleId = "a", lang = "en", addonName = "OpenSubtitles v3"),
          AddonSubtitleDto(subtitleId = "b", lang = "en", addonName = "OpenSubtitles v3"),
        ),
        capabilities = capabilities,
        delay = 0.0,
        delayEnabled = false,
        onAudio = {},
        onSubtitle = {},
        onDelay = {},
        onClose = {},
      )
    }

    compose.onNodeWithTag(addonRowTag(0)).assertExists()
    compose.onNodeWithTag(addonRowTag(1)).assertExists()
    compose.onNodeWithText("EN · OpenSubtitles v3 · 1").assertExists()
    compose.onNodeWithText("EN · OpenSubtitles v3 · 2").assertExists()
  }

  @Test
  fun `Back closes the panel and the opener takes the remote back`() {
    compose.setContent {
      var open by remember { mutableStateOf(true) }
      val opener = remember { FocusRequester() }
      Box(Modifier.fillMaxSize()) {
        Box(
          Modifier
            .testTag("opener")
            .focusRequester(opener)
            .focusable()
            .background(Color.Black),
        )
        if (open) {
          PlayerTracksPanel(
            audioTracks = audio,
            audioTrackIndex = 0,
            subtitleTracks = embedded,
            subtitle = SubtitleChoice.Off,
            addonSubtitles = emptyList(),
            capabilities = capabilities,
            delay = 0.0,
            delayEnabled = false,
            onAudio = {},
            onSubtitle = {},
            onDelay = {},
            onClose = {
              open = false
              runCatching { opener.requestFocus() }
            },
          )
        }
      }
    }

    compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()

    compose.onNodeWithTag(TagTracksPanel).assertDoesNotExist()
    assertTrue(compose.onAllNodes(hasTestTag("opener") and isFocused()).fetchSemanticsNodes().isNotEmpty())
  }
}
