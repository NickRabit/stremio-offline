@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.profiles

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.AvatarDto
import cz.stremiooffline.tv.ui.FakeTvApi
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class AvatarPickerScreenTest {

  @get:Rule val compose = createEmptyComposeRule()

  private lateinit var scenario: ActivityScenario<ComponentActivity>
  private val changes = mutableListOf<AvatarDto?>()
  private var closes = 0

  @Before
  fun launchHost() {
    scenario = ActivityScenario.launch(
      Intent(ApplicationProvider.getApplicationContext(), ComponentActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
  }

  @After
  fun closeHost() {
    scenario.close()
  }

  private fun mount(api: FakeTvApi, avatar: AvatarDto? = null) {
    scenario.onActivity { activity ->
      activity.setContent {
        AvatarPickerScreen(
          api = api,
          name = "Jana",
          seed = "usr_jana",
          avatar = avatar,
          onChanged = { changes += it },
          onClose = { closes += 1 },
        )
      }
    }
    compose.waitUntil(5_000) { api.avatarPresetCalls == 1 }
    compose.waitForIdle()
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  @Test
  fun `the grid lists every preset in display order`() {
    val api = FakeTvApi().apply { avatarPresetsValue = listOf("cat-face", "fox", "owl") }
    mount(api)

    listOf("cat-face", "fox", "owl").forEach {
      compose.onNodeWithTag(avatarPresetTag(it)).assertExists()
    }
    val first = compose.onNodeWithTag(avatarPresetTag("cat-face")).fetchSemanticsNode().boundsInRoot
    val second = compose.onNodeWithTag(avatarPresetTag("fox")).fetchSemanticsNode().boundsInRoot
    assertEquals(first.top, second.top, 0.1f)
    assertEquals(true, first.left < second.left)
  }

  @Test
  fun `OK on a preset saves it and closes`() {
    val api = FakeTvApi().apply { avatarPresetsValue = listOf("fox", "cat-face") }
    mount(api)

    press(Key.DirectionDown)
    compose.onNodeWithTag(avatarPresetTag("fox")).assertIsFocused()
    press(Key.DirectionCenter)

    assertEquals(listOf<String?>("fox"), api.avatarValues)
    assertEquals(listOf<AvatarDto?>(AvatarDto(kind = "preset", id = "fox")), changes)
    assertEquals(1, closes)
  }

  @Test
  fun `Use the initial clears the avatar and closes`() {
    val api = FakeTvApi()
    mount(api, AvatarDto(kind = "custom", url = "/api/avatar/usr_jana?v=1"))
    compose.onNodeWithTag(TagAvatarInitial).assertIsFocused()

    press(Key.DirectionCenter)

    assertEquals(listOf<String?>(null), api.avatarValues)
    assertEquals(listOf<AvatarDto?>(null), changes)
    assertEquals(1, closes)
  }

  @Test
  fun `the chosen preset takes initial focus`() {
    val api = FakeTvApi().apply { avatarPresetsValue = listOf("fox", "cat-face", "owl") }
    mount(api, AvatarDto(kind = "preset", id = "cat-face"))

    compose.onNodeWithTag(avatarPresetTag("cat-face")).assertIsFocused()
  }

  @Test
  fun `Back closes without saving`() {
    val api = FakeTvApi()
    mount(api)

    scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()

    assertEquals(1, closes)
    assertEquals(emptyList<String?>(), api.avatarValues)
  }

  @Test
  fun `a failed save keeps the picker open and shows the error`() {
    val api = FakeTvApi().apply {
      avatarPresetsValue = listOf("fox")
      avatarFailure = ApiFailure.Forbidden
    }
    mount(api)

    press(Key.DirectionDown)
    press(Key.DirectionCenter)

    assertEquals(0, closes)
    compose.onNodeWithTag(TagAvatarPicker).assertExists()
    compose.onNodeWithTag(TagAvatarError).assertExists()
  }
}
