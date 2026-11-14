@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.profiles

import android.content.Intent
import android.view.KeyEvent as AndroidKeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performKeyPress
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.ProfileDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.settings.SettingsRoute
import cz.stremiooffline.tv.ui.settings.TagSettingsRowAccount
import cz.stremiooffline.tv.ui.settings.TagSettingsRowServer
import cz.stremiooffline.tv.ui.settings.TagSettingsRowSwitchProfile
import cz.stremiooffline.tv.ui.shell.Section
import cz.stremiooffline.tv.ui.shell.Shell
import cz.stremiooffline.tv.ui.shell.railTag
import androidx.compose.runtime.remember
import androidx.compose.ui.focus.FocusRequester
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class ProfileEntryTest {

  @get:Rule val compose = createEmptyComposeRule()

  private lateinit var scenario: ActivityScenario<ComponentActivity>

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

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun fakeApi() = FakeTvApi().apply {
    settingsValue = SettingsResponse(uiLanguage = "en", startView = "home")
  }

  private val household = listOf(
    ProfileDto("usr_ondra", "Ondra", "password", current = true),
    ProfileDto("usr_jana", "Jana", "pin"),
  )

  @Test
  fun `Settings shows Switch profile only with canSwitch and OK opens the switcher`() {
    val api = fakeApi()
    scenario.onActivity { activity ->
      activity.setContent {
        SettingsRoute(
          api = api,
          username = "Ondra",
          focusRequester = remember { FocusRequester() },
          onSignOut = {},
          onLocale = {},
          canSwitch = false,
        )
      }
    }
    compose.waitForIdle()
    compose.onNodeWithTag(TagSettingsRowSwitchProfile).assertDoesNotExist()

    val profiles = FakeProfileApi(household)
    scenario.onActivity { activity ->
      activity.setContent {
        Shell(
          start = Section.Account,
          api = api,
          username = "Ondra",
          onSignOut = {},
          canSwitch = true,
          profileApi = profiles,
        )
      }
    }
    compose.waitForIdle()
    compose.onNodeWithTag(TagSettingsRowServer).assertIsFocused()
    press(Key.DirectionDown)
    compose.onNodeWithTag(TagSettingsRowAccount).assertIsFocused()
    press(Key.DirectionDown)
    compose.onNodeWithTag(TagSettingsRowSwitchProfile).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitForIdle()
    compose.onNodeWithTag(TagProfileSwitcher).assertExists()
  }

  @Test
  fun `long-press OK on the rail account item opens the switcher and a short press opens Settings`() {
    val api = fakeApi()
    val profiles = FakeProfileApi(household)
    scenario.onActivity { activity ->
      activity.setContent {
        Shell(
          start = Section.Home,
          api = api,
          username = "Ondra",
          onSignOut = {},
          canSwitch = true,
          profileApi = profiles,
        )
      }
    }
    compose.waitForIdle()
    compose.onNodeWithTag(railTag(Section.Account)).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
    compose.onNodeWithTag(railTag(Section.Account)).assertIsFocused()

    compose.onNodeWithTag(railTag(Section.Account)).performKeyPress(
      KeyEvent(
        AndroidKeyEvent(
          0L,
          0L,
          AndroidKeyEvent.ACTION_DOWN,
          AndroidKeyEvent.KEYCODE_DPAD_CENTER,
          1,
        ),
      ),
    )
    compose.waitForIdle()
    compose.onRoot().performKeyPress(
      KeyEvent(AndroidKeyEvent(AndroidKeyEvent.ACTION_UP, AndroidKeyEvent.KEYCODE_DPAD_CENTER)),
    )
    compose.waitForIdle()
    compose.onNodeWithTag(TagProfileSwitcher).assertExists()

    scenario.onActivity { activity ->
      activity.setContent {
        Shell(
          start = Section.Home,
          api = api,
          username = "Ondra",
          onSignOut = {},
          canSwitch = true,
          profileApi = profiles,
        )
      }
    }
    compose.waitForIdle()
    compose.onNodeWithTag(railTag(Section.Account)).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
    compose.onNodeWithTag(railTag(Section.Account)).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitForIdle()
    compose.onNodeWithTag(TagSettingsRowServer).assertExists()
    compose.onNodeWithTag(TagProfileSwitcher).assertDoesNotExist()
  }
}
