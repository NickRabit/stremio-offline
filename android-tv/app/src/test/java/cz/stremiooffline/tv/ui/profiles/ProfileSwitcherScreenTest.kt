@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.profiles

import android.content.Context
import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.ProfileDto
import cz.stremiooffline.tv.data.SwitchOutcome
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import androidx.compose.ui.test.assertIsDisplayed
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.ApiError
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class ProfileSwitcherScreenTest {

  @get:Rule val compose = createEmptyComposeRule()

  private lateinit var scenario: ActivityScenario<ComponentActivity>
  private val dispatcher = UnconfinedTestDispatcher()
  private val context: Context get() = ApplicationProvider.getApplicationContext()

  @Before
  fun launchHost() {
    Dispatchers.setMain(dispatcher)
    scenario = ActivityScenario.launch(
      Intent(ApplicationProvider.getApplicationContext(), ComponentActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
  }

  @After
  fun closeHost() {
    scenario.close()
    Dispatchers.resetMain()
  }

  private val household = listOf(
    ProfileDto("usr_ondra", "Ondra", "password", current = true),
    ProfileDto("usr_jana", "Jana", "pin"),
    ProfileDto("usr_kids", "Kids", "none"),
  )

  private fun mount(api: FakeProfileApi, onClose: () -> Unit = {}, onSwitched: () -> Unit = {}): ProfileSwitcherViewModel {
    val viewModel = ProfileSwitcherViewModel(api, onSwitched)
    scenario.onActivity { activity ->
      activity.setContent { ProfileSwitcherScreen(viewModel, onClose = onClose) }
    }
    compose.waitForIdle()
    return viewModel
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  @Test
  fun `the current profile is skipped by focus and left right move`() {
    mount(FakeProfileApi(household))
    compose.onNodeWithTag(profileTag("usr_jana")).assertIsFocused()
    press(Key.DirectionLeft)
    compose.onNodeWithTag(profileTag("usr_jana")).assertIsFocused()
    press(Key.DirectionRight)
    compose.onNodeWithTag(profileTag("usr_kids")).assertIsFocused()
    press(Key.DirectionLeft)
    compose.onNodeWithTag(profileTag("usr_jana")).assertIsFocused()
  }

  @Test
  fun `a list that cannot be read says so and OK on Try again reads it again`() {
    val api = FakeProfileApi(household).apply { profilesError = ApiError(ApiFailure.Unreachable) }
    mount(api)
    compose.onNodeWithTag(TagProfileError).assertIsDisplayed()
    compose.onNodeWithTag(TagProfilesRetry).assertIsFocused()
    api.profilesError = null
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagProfileError).assertDoesNotExist()
    compose.onNodeWithTag(profileTag("usr_jana")).assertIsFocused()
  }

  @Test
  fun `OK on a none profile calls switchProfile with no secret and reports the switch`() {
    val api = FakeProfileApi(household)
    var switched = 0
    mount(api, onSwitched = { switched++ })
    press(Key.DirectionRight)
    compose.onNodeWithTag(profileTag("usr_kids")).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitForIdle()
    assertEquals(listOf(Triple("usr_kids", null, null)), api.switchCalls)
    assertEquals(1, switched)
  }

  @Test
  fun `PIN pad focus starts on 5 and D-pad 2-4-6-8 then confirm sends the pin`() {
    val api = FakeProfileApi(household)
    mount(api)
    press(Key.DirectionCenter)
    compose.waitForIdle()
    compose.onNodeWithTag(pinKeyTag("5")).assertIsFocused()
    press(Key.DirectionUp); press(Key.DirectionCenter)
    press(Key.DirectionDown); press(Key.DirectionLeft); press(Key.DirectionCenter)
    press(Key.DirectionRight); press(Key.DirectionRight); press(Key.DirectionCenter)
    press(Key.DirectionDown); press(Key.DirectionLeft); press(Key.DirectionCenter)
    press(Key.DirectionDown); press(Key.DirectionRight); press(Key.DirectionCenter)
    compose.waitForIdle()
    assertEquals(listOf(Triple("usr_jana", "2468", null)), api.switchCalls)
  }

  @Test
  fun `number keys and Enter send the pin`() {
    val api = FakeProfileApi(household)
    mount(api)
    press(Key.DirectionCenter)
    compose.waitForIdle()
    compose.onNodeWithTag(pinKeyTag("5")).assertIsFocused()
    press(Key.Two); press(Key.Four); press(Key.Six); press(Key.Eight)
    press(Key.Enter)
    compose.waitForIdle()
    assertEquals(listOf(Triple("usr_jana", "2468", null)), api.switchCalls)
  }

  @Test
  fun `DEL deletes a digit`() {
    val api = FakeProfileApi(household, SwitchOutcome.WrongPin)
    mount(api)
    press(Key.DirectionCenter)
    compose.waitForIdle()
    press(Key.Two); press(Key.Four); press(Key.Six)
    press(Key.Backspace)
    press(Key.Eight)
    press(Key.Enter)
    compose.waitForIdle()
    assertEquals("248", api.switchCalls.single().second)
  }

  @Test
  fun `wrong PIN clears the dots and shows err_bad_pin`() {
    val api = FakeProfileApi(household, SwitchOutcome.WrongPin)
    mount(api)
    press(Key.DirectionCenter)
    compose.waitForIdle()
    press(Key.One); press(Key.Two); press(Key.Three); press(Key.Four)
    press(Key.Enter)
    compose.waitForIdle()
    compose.onNodeWithTag(TagPinDots).assertCountEquals(0)
    compose.onNodeWithText(context.getString(R.string.err_bad_pin)).assertExists()
  }

  @Test
  fun `PinLocked moves to the password step with the hint`() {
    val api = FakeProfileApi(household, SwitchOutcome.PinLocked)
    mount(api)
    press(Key.DirectionCenter)
    compose.waitForIdle()
    press(Key.One); press(Key.Two); press(Key.Three); press(Key.Four)
    press(Key.Enter)
    compose.waitForIdle()
    compose.onNodeWithText(context.getString(R.string.profiles_pin_locked)).assertExists()
    compose.onNodeWithTag(TagProfilePassword).assertExists()
  }

  @Test
  fun `Wait disables confirm`() {
    val api = FakeProfileApi(household, SwitchOutcome.Wait(30))
    mount(api)
    press(Key.DirectionCenter)
    compose.waitForIdle()
    press(Key.One); press(Key.Two); press(Key.Three); press(Key.Four)
    press(Key.Enter)
    compose.waitForIdle()
    compose.onNodeWithTag(pinKeyTag("confirm")).assertIsNotEnabled()
  }

  @Test
  fun `Back from the PIN pad returns to the row`() {
    mount(FakeProfileApi(household))
    press(Key.DirectionCenter)
    compose.waitForIdle()
    compose.onNodeWithTag(TagPinPad).assertExists()
    scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()
    compose.onNodeWithTag(profileTag("usr_jana")).assertExists()
    compose.onNodeWithTag(TagPinPad).assertDoesNotExist()
  }
}

private fun androidx.compose.ui.test.SemanticsNodeInteraction.assertCountEquals(count: Int) {
  val actual = fetchSemanticsNode().children.size
  assertEquals(count, actual)
}
