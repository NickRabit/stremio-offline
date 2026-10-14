@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.DownloadTargetDto
import cz.stremiooffline.tv.data.DownloadResult
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.RemoteCapabilitiesDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.FakeTvApi
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
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
    // One writable library: the To library button queues straight into it, no panel.
    api.librariesValue = listOf(LibraryDto(id = "movies", name = "Movies", type = "movie", writable = true))
    return api
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun focused(tag: String): Boolean =
    compose.onAllNodes(isFocused()).fetchSemanticsNodes()
      .any { it.config.getOrElse(SemanticsProperties.TestTag) { "" } == tag }

  private fun focusFromLeft(tag: String) {
    repeat(6) {
      if (focused(tag)) return
      press(Key.DirectionRight)
    }
    compose.onNodeWithTag(tag).assertIsFocused()
  }

  @Test
  fun `a native original goes straight to the projected destination, without a panel`() {
    val api = readyNative(downloadLibraryId = "box")
    mount(api)
    compose.waitForIdle()

    focusFromLeft(TagCatalogToLibrary)
    press(Key.DirectionCenter)

    assertEquals(listOf("src-native"), api.queuedSourceIds)
    assertEquals(listOf(DownloadTargetDto("box")), api.queuedTargets)
    compose.onNodeWithTag(TagCatalogLibraryPanel).assertDoesNotExist()
  }

  @Test
  fun `a native original with no projected destination lets the server resolve the default`() {
    val api = readyNative(downloadLibraryId = null)
    mount(api)
    compose.waitForIdle()

    focusFromLeft(TagCatalogToLibrary)
    press(Key.DirectionCenter)

    assertEquals(listOf("src-native"), api.queuedSourceIds)
    assertEquals(listOf(null), api.queuedTargets)
    compose.onNodeWithTag(TagCatalogLibraryPanel).assertDoesNotExist()
  }

  @Test
  fun `a destination read that fails queues no native original`() {
    val api = readyNative(downloadLibraryId = "box")
    api.librariesFailure = ApiFailure.Generic
    mount(api)
    compose.waitForIdle()

    focusFromLeft(TagCatalogToLibrary)
    press(Key.DirectionCenter)

    assertEquals(0, api.downloadCalls)
    compose.onNodeWithTag(TagCatalogMessage).assertIsDisplayed()
  }

  /** One native original this account may copy, with two writable destinations in reach. */
  private fun readyNative(downloadLibraryId: String?): FakeTvApi {
    val api = FakeTvApi()
    api.settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", realDebridConfigured = true)
    api.librariesValue = listOf(
      LibraryDto(id = "movies", name = "Movies", type = "movie", writable = true),
      LibraryDto(id = "box", name = "Box", type = "mixed", writable = true),
    )
    api.streamsValues["movie:tt1"] = listOf(
      StreamDto(
        sourceId = "src-native", kind = "remote", playable = true, name = "1080p",
        capabilities = RemoteCapabilitiesDto(downloadToLibrary = true),
        remoteItem = RemoteItemContext(libraryId = "rlib_a", itemId = "i1", mediaSourceId = "m1", progressKey = "k"),
        downloadLibraryId = downloadLibraryId,
      ),
    )
    return api
  }

  @Test
  fun `a successful To library becomes Queued and explains waiting for debrid`() {
    val api = ready()
    api.downloadResult = DownloadResult(id = "j1", status = "waiting")
    mount(api)
    compose.waitForIdle()

    focusFromLeft(TagCatalogToLibrary)
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagCatalogToLibrary).assert(hasContentDescription("Queued", substring = true))
    compose.onNodeWithText("Waiting for Real-Debrid.").assertIsDisplayed()
  }

  @Test
  fun `a forbidden To library says the account may not add to the library`() {
    val api = ready()
    api.downloadFailure = ApiFailure.Forbidden
    mount(api)
    compose.waitForIdle()

    focusFromLeft(TagCatalogToLibrary)
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagCatalogMessage).assertTextContains("This account may not download to the library.")
  }

  /** A refusal the server explained is a failure even though its text matches no catalogue line:
   *  the kind has to be tracked where the message is set, not read back off the drawn string. */
  @Test
  fun `a refusal the server explained is marked as a failure`() {
    val api = ready()
    api.downloadFailure = ApiFailure.Forbidden
    api.downloadFailureMessage = "This account may not save to that library. Choose another one."
    mount(api)
    compose.waitForIdle()

    focusFromLeft(TagCatalogToLibrary)
    press(Key.DirectionCenter)
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogMessage).assertTextContains("Choose another one.", substring = true)
    compose.onNodeWithTag(TagCatalogMessage).assert(SemanticsMatcher.expectValue(CatalogNoticeKind, CatalogNotice.Failure))
  }

  /** One press burst, one job: the button waits for the answer and a second OK cannot post again. */
  @Test
  fun `a second OK while the queue is in flight does not queue again`() {
    val api = ready()
    val gate = CompletableDeferred<Unit>()
    api.downloadGate = gate
    mount(api)
    compose.waitForIdle()

    focusFromLeft(TagCatalogToLibrary)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagCatalogToLibrary).assertIsNotEnabled()
    press(Key.DirectionCenter)

    assertEquals(1, api.downloadCalls)

    gate.complete(Unit)
    compose.waitForIdle()
    compose.onNodeWithTag(TagCatalogToLibrary).assert(hasContentDescription("Queued", substring = true))
  }

  // Found on the owner's server: the Queued mark outlived the source it was queued for.
  @Test
  fun `Queued belongs to the source that was queued and drops when another is picked`() {
    val api = FakeTvApi()
    api.settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", realDebridConfigured = true)
    api.librariesValue = listOf(LibraryDto(id = "movies", name = "Movies", type = "movie", writable = true))
    api.streamsValues["movie:tt1"] = listOf(
      StreamDto(sourceId = "srcA", kind = "remote", playable = true, name = "small", title = "Czech 1 GB", addonName = "alpha"),
      StreamDto(sourceId = "srcB", kind = "remote", playable = true, name = "big", title = "Czech 8 GB", addonName = "beta"),
    )
    mount(api)
    compose.waitForIdle()

    // Recommended puts the largest first, so srcB is queued.
    focusFromLeft(TagCatalogToLibrary)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagCatalogToLibrary).assert(hasContentDescription("Queued", substring = true))

    // Playing the other source drops the mark: the queued job is not for this one.
    focusFromLeft(TagCatalogSources)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()
    press(Key.DirectionDown)
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagCatalogToLibrary).assert(hasContentDescription("To library", substring = true))
  }
}
