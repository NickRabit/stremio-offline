@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.signin

import androidx.activity.ComponentActivity
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class SignInScreenTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private class FakeActions(initial: SignInState) : SignInActions {
    override var state: SignInState by mutableStateOf(initial)
    val changed = mutableListOf<Pair<String, String>>()

    override fun onServerChange(value: String) {
      changed += "server" to value
      state = state.copy(server = value)
    }

    override fun onUsernameChange(value: String) {
      state = state.copy(username = value)
    }

    override fun onPasswordChange(value: String) {
      state = state.copy(password = value)
    }

    override fun checkServer() {}

    override fun signIn() {}

    override fun startPairing() {
      state = state.copy(pairing = PairingState.Waiting("ABCDEF23", 300, 5))
    }

    override fun cancelPairing() {
      state = state.copy(pairing = PairingState.Idle)
    }

    override fun onScreenLeave() {}
  }

  private fun mount(actions: SignInActions = FakeActions(SignInState())) {
    compose.setContent {
      SignInScreen(viewModel = actions, prefillAddress = "http://")
    }
  }

  @Test
  fun `the address field is focused and the text field is not editing`() {
    mount()

    compose.onNodeWithTag(TagAddress).assertIsFocused()
    // Nothing is editing yet, so the inner text field is not focusable.
    compose.onNodeWithTag(TagUsername).assertIsNotFocused()
  }

  @Test
  fun `down moves address to username to password to sign in without OK`() {
    mount()

    compose.onNodeWithTag(TagAddress).performKeyInput { pressKey(Key.DirectionDown) }
    compose.onNodeWithTag(TagUsername).assertIsFocused()

    compose.onNodeWithTag(TagUsername).performKeyInput { pressKey(Key.DirectionDown) }
    compose.onNodeWithTag(TagPassword).assertIsFocused()

    compose.onNodeWithTag(TagPassword).performKeyInput { pressKey(Key.DirectionDown) }
    compose.onNodeWithTag(TagSignIn).assertIsFocused()
  }

  @Test
  fun `down from password sign in reaches the phone action`() {
    mount()
    for (tag in listOf(TagAddress, TagUsername, TagPassword, TagSignIn)) {
      compose.onNodeWithTag(tag).performKeyInput { pressKey(Key.DirectionDown) }
    }
    compose.onNodeWithTag(TagPhone).assertIsFocused()
  }

  @Test
  fun `ok starts editing and down ends it and moves to the next field`() {
    val actions = FakeActions(SignInState())
    mount(actions)

    compose.onNodeWithTag(TagAddress).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.onNodeWithTag(TagAddress).performKeyInput { pressKey(Key.A) }
    // Editing typed into the field, so the value is no longer the untouched default.
    assert(actions.state.server.contains("a") && actions.state.server != "http://") {
      "expected the typed letter: ${actions.state.server}"
    }

    compose.onNodeWithTag(TagAddress).performKeyInput { pressKey(Key.DirectionDown) }
    compose.onNodeWithTag(TagUsername).assertIsFocused()
  }

  @Test
  fun `pairing shows the grouped code and gives focus to cancel`() {
    mount(FakeActions(SignInState(pairing = PairingState.Waiting("ABCDEF23", 300, 5))))

    compose.onNodeWithTag(TagPairCode).assertTextContains("ABCD EF23")
    compose.onNodeWithTag(TagPairCancel).assertIsFocused()
  }

  @Test
  fun `cancel returns to password sign in`() {
    val actions = FakeActions(SignInState(pairing = PairingState.Waiting("ABCDEF23", 300, 5)))
    mount(actions)

    compose.onNodeWithTag(TagPairCancel).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.onNodeWithTag(TagPairCode).assertDoesNotExist()
    compose.onNodeWithTag(TagPhone).assertIsFocused()
    assert(actions.state.pairing == PairingState.Idle)
  }

  @Test
  fun `ok on the phone action shows the code and back returns to sign in`() {
    val actions = FakeActions(SignInState())
    mount(actions)
    for (tag in listOf(TagAddress, TagUsername, TagPassword, TagSignIn)) {
      compose.onNodeWithTag(tag).performKeyInput { pressKey(Key.DirectionDown) }
    }
    compose.onNodeWithTag(TagPhone).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.onNodeWithTag(TagPairCode).assertTextContains("ABCD EF23")
    compose.onNodeWithTag(TagPairCancel).assertIsFocused()

    compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
    compose.onNodeWithTag(TagPairCode).assertDoesNotExist()
    compose.onNodeWithTag(TagPhone).assertIsFocused()
    assert(actions.state.pairing == PairingState.Idle)
  }
}
