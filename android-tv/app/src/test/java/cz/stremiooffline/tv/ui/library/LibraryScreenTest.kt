@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.library

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.test.core.app.ApplicationProvider
import android.content.Intent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.BrowseResult
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.DetailData
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class LibraryScreenTest {

  @get:Rule val compose = createEmptyComposeRule()

  private var host: ComponentActivity? = null
  private lateinit var scenario: androidx.test.core.app.ActivityScenario<ComponentActivity>

  @org.junit.Before
  fun launchHost() {
    scenario = androidx.test.core.app.ActivityScenario.launch(
      Intent(ApplicationProvider.getApplicationContext(), ComponentActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
  }

  @org.junit.After
  fun closeHost() {
    scenario.close()
  }

  private fun folder(path: String, name: String, fileCount: Int = 1) =
    BrowseItem.Folder(path = path, name = name, fileCount = fileCount)

  private fun file(path: String) = BrowseItem.File(path = path, label = path.substringAfterLast('/'))

  private fun mount(
    api: FakeTvApi,
    pendingDelayMs: Long = 1_500L,
    onDetail: (DetailData) -> Unit = {},
  ) {
    scenario.onActivity { activity ->
      host = activity
      activity.setContent {
      LibraryRoute(
        api = api,
        onOpenDetail = onDetail,
        pendingDelayMs = pendingDelayMs,
      )
      }
    }
  }

  // Bug: the first walk of a library answered empty with pending; the screen must not fall into
  // the empty state, and the view model retry is covered by LibraryViewModelTest.
  @Test
  fun `a pending answer with no items shows loading, not the empty state`() {
    var call = 0
    val api = object : FakeTvApi() {
      override suspend fun browse(path: String?, limit: Int, skip: Int): BrowseResult {
        call++
        return BrowseResult(path.orEmpty(), emptyList(), 1, pending = true)
      }
    }
    mount(api, pendingDelayMs = 5L)

    assertEquals(1, call)
    compose.onNodeWithTag("Films").assertDoesNotExist()
  }

  @Test
  fun `the root page shows the fake's folders`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult("", listOf(folder("Films", "Films"), folder("Shows", "Shows")), 2, false)
    mount(api)

    compose.onNodeWithTag("Films").assertIsFocused()
    compose.onNodeWithTag("Shows").assertExists()
  }

  @Test
  fun `ok on a folder whose browse is only files opens the detail`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult("", listOf(folder("Films/It", "It")), 1, false)
    api.pages["Films/It"] = BrowseResult("Films/It", listOf(file("Films/It/It.mkv")), 1, false)
    val details = mutableListOf<DetailData>()
    mount(api, onDetail = { details += it })

    compose.waitForIdle()
    compose.onNodeWithTag("Films/It").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    assertEquals(1, details.size)
    assertEquals("It", details[0].title)
  }

  @Test
  fun `ok on a folder with subfolders opens a nested grid and back restores focus`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult("", listOf(folder("Shows", "Shows")), 1, false)
    api.pages["Shows"] = BrowseResult("Shows", listOf(folder("Shows/S1", "S1"), folder("Shows/S2", "S2")), 2, false)
    mount(api)

    compose.onNodeWithTag("Shows").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()
    compose.onNodeWithTag("Shows/S2").assertExists()

    // The nested grid's first card takes focus.
    compose.onNodeWithTag("Shows/S1").assertIsFocused()
    // Moving right shows the whole row, then Back returns to the parent with the card focused.
    compose.onNodeWithTag("Shows/S1").performKeyInput { pressKey(Key.DirectionRight) }
    compose.onNodeWithTag("Shows/S2").assertIsFocused()

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()
    compose.onNodeWithTag("Shows/S2").assertDoesNotExist()
    compose.onNodeWithTag("Shows").assertIsFocused()
  }

  // Bug 5: `openedBy` recorded a folder that opened the detail too, so the next Back restored
  // focus to the wrong card.
  @Test
  fun `a folder that opened and closed a detail does not shift the next back's focus`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult(
      "",
      listOf(folder("It", "It"), folder("S1", "S1")),
      2,
      false,
    )
    api.pages["It"] = BrowseResult("It", listOf(file("It/It.mkv")), 1, false)
    api.pages["S1"] = BrowseResult("S1", listOf(folder("S1/E1", "E1")), 1, false)
    val details = mutableListOf<DetailData>()
    mount(api, onDetail = { details += it })
    compose.waitForIdle()

    // Open the only-files folder: it opens the detail and must not be booked as a pushed level.
    compose.onNodeWithTag("It").assertIsFocused()
    compose.onNodeWithTag("It").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    assertEquals(1, details.size)

    // The grid kept the folder focused; RIGHT reaches the nested folder. Push it and go Back: its
    // own card must take focus, not the folder that opened the detail earlier.
    compose.onNodeWithTag("It").performKeyInput { pressKey(Key.DirectionRight) }
    compose.waitForIdle()
    compose.onNodeWithTag("S1").assertIsFocused()
    compose.onNodeWithTag("S1").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.onNodeWithTag("S1/E1").assertExists()

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()
    compose.onNodeWithTag("S1").assertIsFocused()
    compose.onNodeWithTag("S1/E1").assertDoesNotExist()
  }

  @Test
  fun `the root hides the Favourites card when the server has none`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult("", listOf(folder("Films", "Films")), 1, false)
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithTag(FavoritesPath).assertDoesNotExist()
    compose.onNodeWithTag("Films").assertIsFocused()
  }

  @Test
  fun `the root leads with the Favourites card when the server has favourites`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult("", listOf(folder("Films", "Films")), 1, false)
    api.favoritesValue = BrowseResult(FavoritesPath, listOf(file("lib_1/It.mkv")), 1, false)
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithTag(FavoritesPath).assertIsFocused()
    compose.onNodeWithTag("Films").assertExists()
  }

  @Test
  fun `ok on the Favourites card opens its grid and back restores focus to it`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult("", listOf(folder("Films", "Films")), 1, false)
    api.favoritesValue = BrowseResult(
      FavoritesPath,
      listOf(folder("lib_1/It", "It"), file("lib_1/Looper.mkv")),
      2,
      false,
    )
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithTag(FavoritesPath).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    // The Favourites grid draws the same cards as a folder: a folder and a file.
    compose.onNodeWithTag("lib_1/It").assertExists()
    compose.onNodeWithTag("lib_1/Looper.mkv").assertExists()
    compose.onNodeWithTag(FavoritesPath).assertDoesNotExist()

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()
    compose.onNodeWithTag("lib_1/It").assertDoesNotExist()
    compose.onNodeWithTag(FavoritesPath).assertIsFocused()
  }

  @Test
  fun `ok on a favourite file opens its detail`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult("", emptyList(), 0, false)
    api.favoritesValue = BrowseResult(FavoritesPath, listOf(file("lib_1/It.mkv")), 1, false)
    val details = mutableListOf<DetailData>()
    mount(api, onDetail = { details += it })
    compose.waitForIdle()

    compose.onNodeWithTag(FavoritesPath).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.onNodeWithTag("lib_1/It.mkv").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    assertEquals(1, details.size)
    assertEquals("lib_1/It.mkv", details[0].gridPath)
  }

}
