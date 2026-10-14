@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.BrowseResult
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.TagDetailForget
import cz.stremiooffline.tv.ui.detail.TagDetailWatched
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The real shell must wire the detail's Forget to the API, so a clear survives reopening. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class LibraryDetailForgetShellTest {

  @get:Rule val compose = createEmptyComposeRule()

  private lateinit var scenario: ActivityScenario<ComponentActivity>

  private val path = "It/It.mkv"

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

  private fun api() = FakeTvApi().apply {
    pages[null] = BrowseResult(
      path = "",
      items = listOf(BrowseItem.Folder(path = "It", name = "It", fileCount = 1)),
      total = 1,
      pending = false,
    )
    pages["It"] = BrowseResult(
      path = "It",
      items = listOf(BrowseItem.File(path = path, label = "It.mkv")),
      total = 1,
      pending = false,
    )
    progressValues["file:$path"] = ProgressDto(position = 38.6, duration = 120.0)
  }

  private fun mount(api: FakeTvApi) {
    scenario.onActivity { activity ->
      activity.setContent { Shell(start = Section.Library, api = api, username = "demo", onSignOut = {}) }
    }
    compose.waitForIdle()
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun focused(tag: String): Boolean =
    compose.onAllNodes(isFocused()).fetchSemanticsNodes()
      .any { it.config.getOrElse(SemanticsProperties.TestTag) { "" } == tag }

  private fun back() {
    scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()
  }

  /** The root's only folder holds files, so it opens a library detail. */
  private fun openIt() {
    compose.onNodeWithTag("It").assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitForIdle()
  }

  private fun focusByTag(tag: String) {
    repeat(4) {
      if (focused(tag)) return
      press(Key.DirectionRight)
    }
    compose.onNodeWithTag(tag).assertIsFocused()
  }

  @Test
  fun `forget through the real shell clears the position and keeps it cleared on reopen`() {
    val api = api()
    mount(api)

    openIt()
    compose.onNodeWithText("Resume").assertExists()
    compose.onNodeWithTag(TagDetailWatched).assertTextContains("32 % watched")

    focusByTag(TagDetailForget)
    press(Key.DirectionCenter)
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    compose.waitForIdle()

    assertEquals(listOf(listOf("file:$path")), api.forgetCalls)
    assertFalse(api.progressValues.containsKey("file:$path"))
    compose.onNodeWithText("Play").assertExists()
    compose.onNodeWithTag(TagDetailWatched).assertDoesNotExist()

    back()
    openIt()

    compose.onNodeWithText("Play").assertExists()
    compose.onNodeWithTag(TagDetailWatched).assertDoesNotExist()
    compose.onNodeWithTag(TagDetailForget).assertDoesNotExist()
  }
}
