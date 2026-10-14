@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.detail

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.DownloadTargetDto
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.RemoteCapabilitiesDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteItemStateDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.catalog.nativeQueueLibraryTag
import cz.stremiooffline.tv.ui.catalog.nativeQueueVersionTag
import cz.stremiooffline.tv.ui.catalog.TagNativeQueueNoTargets
import cz.stremiooffline.tv.ui.FakeTvApi
import kotlinx.coroutines.CompletableDeferred
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The native remote detail persists its clear through the state endpoint, keeps its flags and
 *  never lets another version wear a position it did not store. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class RemoteDetailTest {

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

  private fun data() = RemoteDetailData(
    libraryId = "rlibA",
    libraryName = "Filmy",
    provider = "jellyfin",
    item = RemoteItemDto(id = "iA", name = "Heat", type = "movie"),
  )

  private fun version(sourceId: String) = StreamDto(
    sourceId = sourceId,
    kind = "remote",
    playable = true,
    name = "Version $sourceId",
    remoteItem = RemoteItemContext(
      libraryId = "rlibA",
      itemId = "iA",
      mediaSourceId = sourceId,
      progressKey = "remote:rlibA:iA",
    ),
  )

  private val played = mutableListOf<PlayTarget>()

  private fun mount(api: FakeTvApi) {
    scenario.onActivity { activity ->
      activity.setContent {
        RemoteDetailScreen(api = api, data = data(), onPlay = { played += it }, onBack = {})
      }
    }
    compose.waitForIdle()
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  /** RIGHT from Play walks the toolbar; the target holds focus once it is reached. */
  private fun focusByLabel(label: String) {
    repeat(6) {
      val onTarget = compose.onAllNodes(isFocused() and hasContentDescription(label)).fetchSemanticsNodes().isNotEmpty()
      if (onTarget) return
      press(Key.DirectionRight)
    }
    compose.onNodeWithContentDescription(label).assertIsFocused()
  }

  @Test
  fun `forget sends a zeroed patch without touching the favourite or watched flags`() {
    val api = FakeTvApi()
    api.remoteSourcesValue = listOf(version("a1"))
    api.remoteStateValue = RemoteItemStateDto(
      position = 900.0,
      duration = 1800.0,
      favorite = true,
      watched = true,
      mediaSourceId = "a1",
    )
    mount(api)

    focusByLabel("Forget progress")
    press(Key.DirectionCenter)

    val patch = api.remoteStatePatches.single()
    assertEquals(0.0, patch.position ?: -1.0, 0.0)
    assertEquals(0.0, patch.duration ?: -1.0, 0.0)
    assertNull(patch.favorite)
    assertNull(patch.watched)
    assertEquals("a1", api.remoteStateValue.mediaSourceId)
    // The local stored position is gone, so the bar and the control with it.
    compose.onNodeWithTag(TagRemoteDetailWatched).assertDoesNotExist()
    compose.onNodeWithContentDescription("Forget progress").assertDoesNotExist()
  }

  @Test
  fun `a failed forget keeps the stored position and shows the failure`() {
    val api = FakeTvApi()
    api.remoteSourcesValue = listOf(version("a1"))
    api.remoteStateValue = RemoteItemStateDto(position = 900.0, duration = 1800.0, favorite = true, mediaSourceId = "a1")
    api.remoteStatePatchFailure = ApiError(ApiFailure.Generic)
    mount(api)

    focusByLabel("Forget progress")
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagRemoteDetailWatched).assertTextContains("50 % watched")
    compose.onNodeWithText("Your saved position could not be loaded.").assertExists()
  }

  @Test
  fun `a failed forget keeps a Start over that plays without resume`() {
    val api = FakeTvApi()
    api.remoteSourcesValue = listOf(version("a1"))
    api.remoteStateValue = RemoteItemStateDto(position = 900.0, duration = 1800.0, mediaSourceId = "a1")
    api.remoteStatePatchFailure = ApiError(ApiFailure.Generic)
    mount(api)

    focusByLabel("Forget progress")
    press(Key.DirectionCenter)

    compose.onNodeWithContentDescription("Start over").assertExists()
    // Back to the primary action, then one step right onto Start over.
    compose.onNodeWithTag(TagRemoteDetailPlay).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
    press(Key.DirectionRight)
    press(Key.DirectionCenter)

    assertEquals(1, played.size)
    assertEquals(false, played.single().resume)
  }

  @Test
  fun `a stored version that is no longer offered shows no other version's progress`() {
    val api = FakeTvApi()
    api.remoteSourcesValue = listOf(version("a1"))
    api.remoteStateValue = RemoteItemStateDto(position = 900.0, duration = 1800.0, mediaSourceId = "gone")
    mount(api)

    compose.onNodeWithTag(TagRemoteDetailWatched).assertDoesNotExist()
    compose.onNodeWithText("Play").assertExists()
  }

  private fun copyableVersion(sourceId: String) = StreamDto(
    sourceId = sourceId,
    kind = "remote",
    playable = true,
    name = "Version $sourceId",
    capabilities = RemoteCapabilitiesDto(downloadToLibrary = true),
    remoteItem = RemoteItemContext(libraryId = "rlibA", itemId = "iA", mediaSourceId = sourceId, progressKey = "remote:rlibA:iA"),
  )

  private fun mountCopy(api: FakeTvApi) {
    scenario.onActivity { activity ->
      activity.setContent {
        RemoteDetailScreen(
          api = api,
          data = data(),
          onPlay = { played += it },
          onBack = {},
          loadDestinations = { api.libraries() },
          onQueue = { title, sourceId, media, libraryId -> api.download(title, sourceId, media, DownloadTargetDto(libraryId)) },
        )
      }
    }
    compose.waitForIdle()
  }

  @Test
  fun `queues the exact version the viewer picked into the exact library`() {
    val api = FakeTvApi()
    api.remoteSourcesValue = listOf(copyableVersion("ms1"), copyableVersion("ms2"))
    api.librariesValue = listOf(LibraryDto(id = "libA", name = "Filmy", type = "movie", writable = true))
    mountCopy(api)

    activate(TagRemoteDetailToLibrary)
    awaitTag(nativeQueueVersionTag("ms2"))
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    awaitTag(nativeQueueLibraryTag("libA"))
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.queuedSourceIds.isNotEmpty() }

    assertEquals(listOf("ms2"), api.queuedSourceIds)
    assertEquals("libA", api.queuedTargets.single()?.libraryId)
    // The media the queue carries names the film through its own exact id, never a file name.
    assertEquals("movie", api.downloads.single().second.kind)
    assertEquals("Heat", api.downloads.single().second.title)
  }

  @Test
  fun `a denied native right offers no copy action at all`() {
    val api = FakeTvApi()
    api.remoteSourcesValue = listOf(version("a1"))
    api.librariesValue = listOf(LibraryDto(id = "libA", name = "Filmy", type = "movie", writable = true))
    mountCopy(api)

    compose.onNodeWithTag(TagRemoteDetailToLibrary).assertDoesNotExist()
    compose.onNodeWithText("To library").assertDoesNotExist()
  }

  @Test
  fun `the projected destination leads the copy panel`() {
    val api = FakeTvApi()
    api.remoteSourcesValue = listOf(copyableVersion("ms1").copy(downloadLibraryId = "libB"))
    api.librariesValue = listOf(
      LibraryDto(id = "libA", name = "Filmy", type = "movie", writable = true),
      LibraryDto(id = "libB", name = "Serialy", type = "movie", writable = true),
    )
    mountCopy(api)

    activate(TagRemoteDetailToLibrary)
    awaitTag(nativeQueueLibraryTag("libB"))
    compose.onNodeWithTag(nativeQueueLibraryTag("libB")).assertIsSelected()
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.queuedSourceIds.isNotEmpty() }

    assertEquals(listOf("ms1"), api.queuedSourceIds)
    assertEquals("libB", api.queuedTargets.single()?.libraryId)
  }

  @Test
  fun `Back closes the copy panel before the detail, and Play still works`() {
    val api = FakeTvApi()
    api.remoteSourcesValue = listOf(copyableVersion("ms1"))
    api.librariesValue = listOf(LibraryDto(id = "libA", name = "Filmy", type = "movie", writable = true))
    var backs = 0
    scenario.onActivity { activity ->
      activity.setContent {
        RemoteDetailScreen(
          api = api,
          data = data(),
          onPlay = { played += it },
          onBack = { backs += 1 },
          loadDestinations = { api.libraries() },
          onQueue = { title, sourceId, media, libraryId -> api.download(title, sourceId, media, DownloadTargetDto(libraryId)) },
        )
      }
    }
    compose.waitForIdle()
    activate(TagRemoteDetailToLibrary)
    awaitTag(nativeQueueLibraryTag("libA"))
    press(Key.Back)
    awaitGone(nativeQueueLibraryTag("libA"))
    assertEquals(0, backs)

    // The ordinary play action is untouched by the copy feature.
    activate(TagRemoteDetailPlay)
    assertEquals(1, played.size)
  }

  private fun awaitTag(tag: String) {
    compose.waitUntil(5_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }
  }

  private fun awaitGone(tag: String) {
    compose.waitUntil(5_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isEmpty() }
  }

  /** The remote's own way of working a control: the D-pad lands on it and OK presses it. */
  private fun activate(tag: String) {
    compose.onNodeWithTag(tag).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
    press(Key.DirectionCenter)
  }

  private fun openCopy(api: FakeTvApi, copyable: String = "ms1") {
    api.remoteSourcesValue = listOf(copyableVersion(copyable))
    api.librariesValue = listOf(LibraryDto(id = "libA", name = "Filmy", type = "movie", writable = true))
    mountCopy(api)
    activate(TagRemoteDetailToLibrary)
    awaitTag(nativeQueueLibraryTag("libA"))
  }

  @Test
  fun `a second OK while the copy is in flight queues nothing more`() {
    val api = FakeTvApi()
    api.downloadGate = CompletableDeferred()
    openCopy(api)

    press(Key.DirectionCenter)
    press(Key.DirectionCenter)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.downloadCalls == 1 }
    assertEquals(1, api.downloadCalls)

    api.downloadGate?.complete(Unit)
    compose.waitUntil(5_000) { api.queuedSourceIds.isNotEmpty() }
    assertEquals(listOf("ms1"), api.queuedSourceIds)
  }

  @Test
  fun `Back holds the copy panel while the queue call is in flight`() {
    val api = FakeTvApi()
    api.downloadGate = CompletableDeferred()
    var backs = 0
    api.remoteSourcesValue = listOf(copyableVersion("ms1"))
    api.librariesValue = listOf(LibraryDto(id = "libA", name = "Filmy", type = "movie", writable = true))
    scenario.onActivity { activity ->
      activity.setContent {
        RemoteDetailScreen(
          api = api,
          data = data(),
          onPlay = { played += it },
          onBack = { backs += 1 },
          loadDestinations = { api.libraries() },
          onQueue = { title, sourceId, media, libraryId -> api.download(title, sourceId, media, DownloadTargetDto(libraryId)) },
        )
      }
    }
    compose.waitForIdle()
    activate(TagRemoteDetailToLibrary)
    awaitTag(nativeQueueLibraryTag("libA"))
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.downloadCalls == 1 }

    press(Key.Back)
    compose.onNodeWithTag(nativeQueueLibraryTag("libA")).assertExists()
    assertEquals(0, backs)

    api.downloadGate?.complete(Unit)
    compose.waitUntil(5_000) { api.queuedSourceIds.isNotEmpty() }
    assertEquals(1, api.downloadCalls)
  }

  @Test
  fun `a refused copy keeps the panel and the chosen destination`() {
    val api = FakeTvApi()
    api.downloadFailure = ApiFailure.Generic
    api.downloadFailureMessage = "This source is already in the library."
    openCopy(api)

    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.downloadCalls == 1 }

    compose.onNodeWithTag(nativeQueueLibraryTag("libA")).assertExists()
    compose.onNodeWithText("This source is already in the library.").assertExists()
  }

  @Test
  fun `a library the account may not write to is refused instead of queued`() {
    val api = FakeTvApi()
    api.remoteSourcesValue = listOf(copyableVersion("ms1"))
    api.librariesValue = listOf(LibraryDto(id = "libA", name = "Filmy", type = "movie", writable = false))
    mountCopy(api)

    activate(TagRemoteDetailToLibrary)
    awaitTag(TagNativeQueueNoTargets)
    assertEquals(0, api.downloadCalls)
  }

  @Test
  fun `a destination read that fails says so and queues nothing`() {
    val api = FakeTvApi()
    api.remoteSourcesValue = listOf(copyableVersion("ms1"))
    api.librariesFailure = ApiFailure.Generic
    mountCopy(api)

    activate(TagRemoteDetailToLibrary)
    awaitTag(TagRemoteCopyNotice)

    assertEquals(0, api.downloadCalls)
    compose.onNodeWithTag(nativeQueueLibraryTag("libA")).assertDoesNotExist()
  }

  @Test
  fun `closing the copy panel returns the remote to the action that opened it`() {
    val api = FakeTvApi()
    openCopy(api)

    press(Key.Back)
    awaitGone(nativeQueueLibraryTag("libA"))
    compose.waitUntil(5_000) {
      compose.onAllNodes(isFocused() and hasTestTag(TagRemoteDetailToLibrary)).fetchSemanticsNodes().isNotEmpty()
    }
  }

  @Test
  fun `a destination answer that lands after the item was replaced opens nothing`() {
    val api = FakeTvApi()
    api.remoteSourcesValue = listOf(copyableVersion("ms1"))
    api.librariesValue = listOf(LibraryDto(id = "libA", name = "Filmy", type = "movie", writable = true))
    val gate = CompletableDeferred<Unit>()
    api.librariesGate = gate
    val shown = mutableStateOf(data())
    scenario.onActivity { activity ->
      activity.setContent {
        RemoteDetailScreen(
          api = api,
          data = shown.value,
          onPlay = { played += it },
          onBack = {},
          loadDestinations = { api.libraries() },
          onQueue = { title, sourceId, media, libraryId -> api.download(title, sourceId, media, DownloadTargetDto(libraryId)) },
        )
      }
    }
    compose.waitForIdle()
    activate(TagRemoteDetailToLibrary)
    compose.waitUntil(5_000) { api.librariesCalls == 1 }
    assertEquals(1, api.librariesCalls)

    // The viewer moved on to another item before the destination list arrived.
    compose.runOnIdle { shown.value = data().copy(item = RemoteItemDto(id = "iB", name = "Other", type = "movie")) }
    compose.waitForIdle()
    gate.complete(Unit)
    compose.waitForIdle()

    compose.onNodeWithTag(nativeQueueLibraryTag("libA")).assertDoesNotExist()
    assertEquals(0, api.downloadCalls)
  }
}
