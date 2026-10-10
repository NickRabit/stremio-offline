@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.DownloadResult
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.FakeTvApi
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class QueueTest {

  @get:Rule val compose = createComposeRule()

  private fun mount(api: FakeTvApi) {
    compose.setContent {
      CatalogDetailScreen(
        api = api,
        args = CatalogDetailArgs(MetaDto(id = "tt1", type = "movie", name = "It"), "Cinemeta", "movie"),
        imageUrl = { null },
        onPlay = {},
        onBack = {},
      )
    }
  }

  private fun ready(): FakeTvApi {
    val api = FakeTvApi()
    api.settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", realDebridConfigured = true)
    api.streamsValues["movie:tt1"] = listOf(StreamDto(sourceId = "s1", kind = "torrent", playable = false, title = "Czech 8 GB", addonName = "alpha"))
    return api
  }

  /** tv-material controls activate on DPAD_CENTER once focused; a plain click does not reach them. */
  private fun click(tag: String) {
    compose.onNodeWithTag(tag).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
    compose.onNodeWithTag(tag).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
  }

  @Test
  fun `a successful To library becomes Queued and explains waiting for debrid`() {
    val api = ready()
    api.downloadResult = DownloadResult(id = "j1", status = "waiting")
    mount(api)
    compose.waitForIdle()

    click(TagCatalogToLibrary)

    compose.onNodeWithTag(TagCatalogToLibrary).assertTextContains("Queued", substring = true)
    compose.onNodeWithText("Waiting for Real-Debrid.").assertIsDisplayed()
  }

  @Test
  fun `a forbidden To library says the account may not add to the library`() {
    val api = ready()
    api.downloadFailure = ApiFailure.Forbidden
    mount(api)
    compose.waitForIdle()

    click(TagCatalogToLibrary)

    compose.onNodeWithTag(TagCatalogMessage).assertTextContains("This account may not download to the library.")
  }
}
