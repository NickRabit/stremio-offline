@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.downloads

import android.content.Context
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.DownloadDto
import cz.stremiooffline.tv.data.DownloadsResponseDto
import cz.stremiooffline.tv.ui.FakeTvApi
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class DownloadsScreenTest {

  @get:Rule val compose = createComposeRule()

  private val context: Context get() = ApplicationProvider.getApplicationContext()

  private fun job(id: String, status: String = "downloading", order: Int = 0) =
    DownloadDto(id = id, title = "Title $id", status = status, order = order)

  private fun mount(api: FakeTvApi) {
    compose.setContent { DownloadsScreen(api) }
    compose.waitForIdle()
  }

  private fun advancePoll() {
    compose.mainClock.advanceTimeBy(3_000)
    compose.waitForIdle()
  }

  @Test
  fun `shows active jobs and the footer counts the rest`() {
    val api = FakeTvApi()
    api.downloadsValue = DownloadsResponseDto(
      listOf(
        job("downloading"),
        job("checking", status = "checking", order = 1),
        job("waiting", status = "waiting", order = 2),
        job("queued", status = "queued"),
        job("paused", status = "paused"),
        job("failed", status = "failed"),
        job("completed", status = "completed"),
      ),
    )
    mount(api)

    compose.onNodeWithTag(TagDownloadRow + "downloading").assertExists()
    compose.onNodeWithTag(TagDownloadRow + "checking").assertExists()
    compose.onNodeWithTag(TagDownloadRow + "waiting").assertExists()
    compose.onNodeWithTag(TagDownloadRow + "queued").assertDoesNotExist()
    compose.onNodeWithTag(TagDownloadRow + "paused").assertDoesNotExist()
    compose.onNodeWithTag(TagDownloadRow + "failed").assertDoesNotExist()
    compose.onNodeWithTag(TagDownloadRow + "completed").assertDoesNotExist()

    compose.onNodeWithTag(TagDownloadsFooter).assertExists()
    compose.onNodeWithText(context.getString(R.string.downloads_status_queued)).assertExists()
    compose.onNodeWithText(context.getString(R.string.downloads_status_paused)).assertExists()
    compose.onNodeWithText(context.getString(R.string.downloads_status_failed)).assertExists()
    compose.onAllNodesWithText("1").assertCountEquals(3)
  }

  @Test
  fun `empty active list shows the empty state and queued count`() {
    val api = FakeTvApi()
    api.downloadsValue = DownloadsResponseDto(
      listOf(
        job("queued-a", status = "queued"),
        job("queued-b", status = "queued"),
        job("queued-c", status = "queued"),
      ),
    )
    mount(api)

    compose.onNodeWithText(context.getString(R.string.downloads_empty_active)).assertExists()
    compose.onNodeWithText(context.resources.getQuantityString(R.plurals.tv_downloads_in_queue, 3, 3)).assertExists()
    compose.onNodeWithTag(TagDownloadsFooter).assertExists()
  }

  @Test
  fun `polling every three seconds adds the new active job`() {
    val api = FakeTvApi()
    api.downloadsValue = DownloadsResponseDto(listOf(job("first")))
    mount(api)
    val requestCount = api.downloadsRequests

    api.downloadsValue = DownloadsResponseDto(listOf(job("first"), job("second", order = 1)))
    advancePoll()

    compose.onNodeWithTag(TagDownloadRow + "second").assertExists()
    org.junit.Assert.assertTrue(api.downloadsRequests > requestCount)
  }

  @Test
  fun `focus survives a poll and falls to the first row when its job leaves`() {
    val api = FakeTvApi()
    api.downloadsValue = DownloadsResponseDto(listOf(job("first"), job("second", order = 1), job("third", order = 2)))
    mount(api)

    compose.onNodeWithTag(TagDownloadRow + "second").performSemanticsAction(SemanticsActions.RequestFocus)
    compose.onNodeWithTag(TagDownloadRow + "second").assertIsFocused()

    api.downloadsValue = DownloadsResponseDto(listOf(job("first"), job("second", order = 1), job("third", order = 2)))
    advancePoll()
    compose.onNodeWithTag(TagDownloadRow + "second").assertIsFocused()

    api.downloadsValue = DownloadsResponseDto(listOf(job("first"), job("third", order = 2)))
    advancePoll()
    compose.onNodeWithTag(TagDownloadRow + "second").assertDoesNotExist()
    compose.onNodeWithTag(TagDownloadRow + "first").assertIsFocused()
  }

  @Test
  fun `down moves focus from the first row to the second`() {
    val api = FakeTvApi()
    api.downloadsValue = DownloadsResponseDto(listOf(job("first"), job("second", order = 1)))
    mount(api)

    compose.onNodeWithTag(TagDownloadRow + "first").performSemanticsAction(SemanticsActions.RequestFocus)
    compose.onNodeWithTag(TagDownloadRow + "first").performKeyInput { pressKey(Key.DirectionDown) }
    compose.waitForIdle()

    compose.onNodeWithTag(TagDownloadRow + "second").assertIsFocused()
  }
}
