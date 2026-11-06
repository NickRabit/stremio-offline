@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

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
import cz.stremiooffline.tv.data.DownloadDto
import cz.stremiooffline.tv.data.DownloadsResponseDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.downloads.TagDownloadRow
import cz.stremiooffline.tv.ui.downloads.TagDownloadsScreen
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class DownloadsNavigationTest {

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

  private fun mount(api: FakeTvApi, start: Section = Section.Home) {
    scenario.onActivity { activity ->
      activity.setContent { Shell(start = start, api = api, username = "demo", onSignOut = {}) }
    }
    compose.waitForIdle()
  }

  private fun mountWithApi(
    start: Section = Section.Home,
    jobs: List<DownloadDto> = emptyList(),
  ): FakeTvApi {
    val api = FakeTvApi()
    api.downloadsValue = DownloadsResponseDto(jobs)
    mount(api, start)
    return api
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  @Test
  fun `OK on the rail opens downloads and right and left connect its first row`() {
    mountWithApi(
      start = Section.Favorites,
      jobs = listOf(DownloadDto(id = "first", title = "First", status = "downloading")),
    )

    press(Key.DirectionLeft)
    compose.onNodeWithTag(railTag(Section.Favorites)).assertIsFocused()
    press(Key.DirectionDown)
    compose.onNodeWithTag(railTag(Section.Downloads)).assertIsFocused()
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagDownloadsScreen).assertExists()
    press(Key.DirectionRight)
    compose.onNodeWithTag(TagDownloadRow + "first").assertIsFocused()
    press(Key.DirectionLeft)
    compose.onNodeWithTag(railTag(Section.Downloads)).assertIsFocused()
  }

  @Test
  fun `the rail dot follows active jobs only`() {
    mountWithApi(
      jobs = listOf(DownloadDto(id = "active", status = "downloading")),
    )

    compose.onNodeWithTag(TagRailDownloadingDot, useUnmergedTree = true).assertExists()
  }

  @Test
  fun `queued jobs do not light the rail dot`() {
    mountWithApi(
      jobs = listOf(DownloadDto(id = "queued", status = "queued")),
    )

    compose.onNodeWithTag(TagRailDownloadingDot, useUnmergedTree = true).assertDoesNotExist()
  }
  @Test
  fun `a poll that changes the list does not pull focus back from the rail`() {
    val api = mountWithApi(
      start = Section.Favorites,
      jobs = listOf(
        DownloadDto(id = "a", title = "A", status = "downloading", order = 0),
        DownloadDto(id = "b", title = "B", status = "downloading", order = 1),
      ),
    )
    press(Key.DirectionLeft)
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(railTag(Section.Downloads)).assertIsFocused()
    press(Key.DirectionRight)
    compose.onNodeWithTag(TagDownloadRow + "a").assertIsFocused()
    press(Key.DirectionLeft)
    compose.onNodeWithTag(railTag(Section.Downloads)).assertIsFocused()

    api.downloadsValue = DownloadsResponseDto(listOf(DownloadDto(id = "b", title = "B", status = "downloading", order = 1)))
    compose.mainClock.advanceTimeBy(3_500)
    compose.waitForIdle()

    compose.onNodeWithTag(TagDownloadRow + "a").assertDoesNotExist()
    compose.onNodeWithTag(railTag(Section.Downloads)).assertIsFocused()
  }
}
