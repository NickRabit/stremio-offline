@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.R
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The rail is icons only and never widens; every item keeps a spoken name. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class RailTest {

  @get:Rule val compose = createComposeRule()

  private val context: Context get() = ApplicationProvider.getApplicationContext()

  private fun mount() {
    compose.setContent {
      ShellScaffold(
        username = "demo",
        start = Section.Home,
        current = Section.Home,
        onBackToExit = {},
      ) { requester ->
        Box(
          Modifier
            .fillMaxSize()
            .background(Color.Black)
            .focusRequester(requester)
            .focusable()
            .testTag("content"),
        )
        LaunchedEffect(Unit) { runCatching { requester.requestFocus() } }
      }
    }
  }

  @Test
  fun `each rail item carries its label as a content description`() {
    mount()

    compose.onNodeWithTag(railTag(Section.Search)).assertContentDescriptionEquals(context.getString(R.string.tv_nav_search))
    compose.onNodeWithTag(railTag(Section.Home)).assertContentDescriptionEquals(context.getString(R.string.nav_home))
    compose.onNodeWithTag(railTag(Section.Catalog)).assertContentDescriptionEquals(context.getString(R.string.nav_catalog))
    compose.onNodeWithTag(railTag(Section.Library)).assertContentDescriptionEquals(context.getString(R.string.nav_library))
    // The account item shows the avatar alone; the username is only its spoken name.
    compose.onNodeWithTag(railTag(Section.Account)).assertContentDescriptionEquals("demo")
  }

  @Test
  fun `focusing the rail does not widen it or draw a label`() {
    mount()
    val before = compose.onNodeWithTag(railTag(Section.Home)).getUnclippedBoundsInRoot()

    compose.onNodeWithTag("content").performKeyInput { pressKey(Key.DirectionLeft) }
    compose.waitForIdle()

    compose.onNodeWithTag(railTag(Section.Home)).assertIsFocused()
    val after = compose.onNodeWithTag(railTag(Section.Home)).getUnclippedBoundsInRoot()
    assertEquals(before.left, after.left)
    assertEquals(before.right - before.left, after.right - after.left)
    compose.onNodeWithText(context.getString(R.string.nav_home)).assertDoesNotExist()
  }
}
