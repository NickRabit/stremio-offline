@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import androidx.activity.ComponentActivity
import androidx.compose.runtime.remember
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.AddonSubtitleDto
import cz.stremiooffline.tv.data.ClientCapabilitiesDto
import cz.stremiooffline.tv.playback.SubtitleChoice
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A subtitle addon can answer with hundreds of releases. The panel's rows are a lazy list now, so
 * it opens on the chosen one and only draws what fits on screen.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerTracksPanelLargeTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private val subtitles = (0 until 300).map { AddonSubtitleDto(subtitleId = "sid-$it", lang = "cs", addonName = "OpenSubtitles") }

  private fun mount(subtitle: SubtitleChoice) {
    compose.setContent {
      PlayerTracksPanel(
        audioTracks = emptyList(),
        audioTrackIndex = 0,
        subtitleTracks = emptyList(),
        subtitle = subtitle,
        addonSubtitles = subtitles,
        capabilities = ClientCapabilitiesDto(),
        delay = 0.0,
        delayEnabled = false,
        onAudio = {},
        onSubtitle = {},
        onDelay = {},
        onClose = {},
        initialFocus = remember { FocusRequester() },
      )
    }
    compose.waitForIdle()
  }

  @Test
  fun `three hundred addon subtitles open on the chosen row and walk down`() {
    mount(SubtitleChoice.Addon("sid-150"))

    compose.onNodeWithTag(TagTracksPanel).assertExists()
    compose.onNodeWithTag(addonRowTag(150)).assertIsFocused()
    // Only the rows on screen are composed: a row far below the chosen one is not a node at all.
    compose.onNodeWithTag(addonRowTag(299)).assertDoesNotExist()

    repeat(10) {
      compose.onRoot().performKeyInput { pressKey(Key.DirectionDown) }
      compose.waitForIdle()
    }
    compose.onNodeWithTag(addonRowTag(160)).assertIsFocused()
  }
}
