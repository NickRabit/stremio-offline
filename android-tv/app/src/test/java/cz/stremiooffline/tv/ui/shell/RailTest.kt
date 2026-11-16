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
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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

  private fun mount(
    child: Boolean = false,
    childCatalogue: Boolean = false,
    canSwitch: Boolean = false,
    onSection: (Section) -> Boolean = { false },
    onAccount: () -> Unit = {},
  ) {
    compose.setContent {
      ShellScaffold(
        username = "demo",
        start = Section.Home,
        current = Section.Home,
        onSection = onSection,
        onBackToExit = {},
        canSwitch = canSwitch,
        child = child,
        childCatalogue = childCatalogue,
        onAccountLongPress = onAccount,
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
    compose.onNodeWithTag(railTag(Section.Favorites)).assertContentDescriptionEquals(context.getString(R.string.nav_favorites))
    compose.onNodeWithTag(railTag(Section.Downloads)).assertContentDescriptionEquals(context.getString(R.string.nav_downloads))
    // The account item shows the avatar alone; the username is only its spoken name.
    compose.onNodeWithTag(railTag(Section.Account)).assertContentDescriptionEquals("demo")
  }

  @Test
  fun `downloads sits between favourites and the account and the rail fits the screen`() {
    mount()

    val favorites = compose.onNodeWithTag(railTag(Section.Favorites)).getUnclippedBoundsInRoot()
    val downloads = compose.onNodeWithTag(railTag(Section.Downloads)).getUnclippedBoundsInRoot()
    val account = compose.onNodeWithTag(railTag(Section.Account)).getUnclippedBoundsInRoot()

    assertTrue(favorites.top < downloads.top)
    assertTrue(downloads.top < account.top)
    assertTrue("account rail item ends at ${account.bottom}", account.bottom.value <= 540f)
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

  @Test
  fun `a child rail has Search Home Library and the account item only`() {
    mount(child = true)

    compose.onNodeWithTag(railTag(Section.Search)).assertExists()
    compose.onNodeWithTag(railTag(Section.Home)).assertExists()
    compose.onNodeWithTag(railTag(Section.Library)).assertExists()
    compose.onNodeWithTag(railTag(Section.Account)).assertExists()
    compose.onNodeWithTag(railTag(Section.Catalog)).assertDoesNotExist()
    compose.onNodeWithTag(railTag(Section.Resume)).assertDoesNotExist()
    compose.onNodeWithTag(railTag(Section.Favorites)).assertDoesNotExist()
    compose.onNodeWithTag(railTag(Section.Downloads)).assertDoesNotExist()
  }

  @Test
  fun `catalogue browsing adds Catalogue for a child`() {
    mount(child = true, childCatalogue = true)

    compose.onNodeWithTag(railTag(Section.Catalog)).assertExists()
    compose.onNodeWithTag(railTag(Section.Resume)).assertDoesNotExist()
    compose.onNodeWithTag(railTag(Section.Favorites)).assertDoesNotExist()
    compose.onNodeWithTag(railTag(Section.Downloads)).assertDoesNotExist()
  }

  @Test
  fun `an ordinary account keeps every rail item`() {
    mount()

    Section.entries.forEach { section ->
      compose.onNodeWithTag(railTag(section)).assertExists()
    }
  }

  @Test
  fun `OK on the account opens the switcher when the account can switch`() {
    var switchers = 0
    var sections = 0
    mount(
      canSwitch = true,
      onSection = { sections += 1; true },
      onAccount = { switchers += 1 },
    )

    compose.onNodeWithTag(railTag(Section.Account)).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.onNodeWithTag(railTag(Section.Account)).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    assertEquals(1, switchers)
    assertEquals(0, sections)
  }

  @Test
  fun `OK on the account opens Settings when the account cannot switch`() {
    val selected = mutableListOf<Section>()
    mount(onSection = { selected += it; true })

    compose.onNodeWithTag(railTag(Section.Account)).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.onNodeWithTag(railTag(Section.Account)).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    assertEquals(listOf(Section.Account), selected)
  }

  @Test
  fun `a child account opens the switcher as before`() {
    var switchers = 0
    mount(child = true, onAccount = { switchers += 1 })

    compose.onNodeWithTag(railTag(Section.Account)).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.onNodeWithTag(railTag(Section.Account)).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    assertEquals(1, switchers)
  }
}
