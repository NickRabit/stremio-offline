@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.SearchResultDto
import cz.stremiooffline.tv.data.SearchScope
import cz.stremiooffline.tv.ui.FakeTvApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class VoiceSearchScreenTest {

  @get:Rule val compose = createComposeRule()

  /** The seam the screen was handed: each press it recorded, answered when the test says so. */
  private class Voice {
    val calls = mutableListOf<(String) -> Unit>()

    fun answer(spoken: String) {
      calls.last()(spoken)
    }
  }

  private val voice = Voice()

  /** How many key-downs reached the outside of the screen, so consumption is visible. */
  private var bubbled = 0

  private fun meta(id: String, name: String = id) = MetaDto(id = id, type = "movie", name = name)

  private fun mount(api: FakeTvApi, voiceAvailable: Boolean = true) {
    compose.setContent {
      Box(
        Modifier.fillMaxSize().onKeyEvent { event ->
          if (event.type == KeyEventType.KeyDown) bubbled += 1
          false
        },
      ) {
        SearchScreen(
          api = api,
          scope = SearchScope(),
          onScopeChange = {},
          onOpenDetail = {},
          imageUrl = { null },
          voiceAvailable = voiceAvailable,
          voiceLauncher = { onResult -> voice.calls += onResult },
        )
      }
    }
    compose.waitForIdle()
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  /** The field takes focus first, so one RIGHT reaches the chip and the next the mic. */
  private fun focusMic() {
    press(Key.DirectionRight)
    press(Key.DirectionRight)
    compose.onNodeWithTag(TagSearchVoice).assertIsFocused()
  }

  @Test
  fun `the mic sits right of the scope chip`() {
    mount(FakeTvApi())

    compose.onNodeWithTag(TagSearchVoice).assertTextContains("Voice search")
    compose.onNodeWithContentDescription("Voice search").assertExists()

    press(Key.DirectionRight)
    compose.onNodeWithTag(TagSearchScopeChip).assertIsFocused()
    press(Key.DirectionRight)
    compose.onNodeWithTag(TagSearchVoice).assertIsFocused()
    press(Key.DirectionLeft)
    compose.onNodeWithTag(TagSearchScopeChip).assertIsFocused()
  }

  @Test
  fun `without a recognizer there is no mic button`() {
    mount(FakeTvApi(), voiceAvailable = false)

    compose.onNodeWithTag(TagSearchVoice).assertDoesNotExist()
    compose.onNodeWithTag(TagSearchScopeChip).assertExists()
  }

  @Test
  fun `ok on the mic asks the recognizer`() {
    val api = FakeTvApi()
    mount(api)

    focusMic()
    press(Key.DirectionCenter)

    assertEquals(1, voice.calls.size)
    assertTrue(api.searchRequests.isEmpty())
  }

  @Test
  fun `the spoken words fill the field and run the search`() {
    val api = FakeTvApi()
    api.searchPages[""] = SearchResultDto(items = listOf(meta("tt9", "Heat")), cursor = "", hasMore = false)
    mount(api)

    focusMic()
    press(Key.DirectionCenter)
    voice.answer("  heat  ")
    compose.waitForIdle()

    assertEquals("heat", api.searchRequests.single().query)
    compose.onNodeWithTag(TagSearchInput).assertTextContains("heat")
    compose.onNodeWithText("Type a title, then press Done.").assertDoesNotExist()
  }

  @Test
  fun `a blank answer changes nothing`() {
    val api = FakeTvApi()
    mount(api)

    focusMic()
    press(Key.DirectionCenter)
    voice.answer("   ")
    compose.waitForIdle()

    assertTrue(api.searchRequests.isEmpty())
    compose.onNodeWithText("Type a title, then press Done.").assertExists()
  }

  @Test
  fun `a cancelled answer changes nothing`() {
    val api = FakeTvApi()
    mount(api)

    focusMic()
    press(Key.DirectionCenter)

    assertEquals(1, voice.calls.size)
    assertTrue(api.searchRequests.isEmpty())
    compose.onNodeWithText("Type a title, then press Done.").assertExists()
  }

  @Test
  fun `the remote mic keys start the recognizer`() {
    mount(FakeTvApi())
    bubbled = 0

    press(Key.Search)
    press(Key.VoiceAssist)
    press(Key.Assist)

    assertEquals(3, voice.calls.size)
    assertEquals(0, bubbled)
  }

  @Test
  fun `without a recognizer the mic key is left alone`() {
    mount(FakeTvApi(), voiceAvailable = false)
    bubbled = 0

    press(Key.VoiceAssist)

    assertTrue(voice.calls.isEmpty())
    assertEquals(1, bubbled)
  }
}
