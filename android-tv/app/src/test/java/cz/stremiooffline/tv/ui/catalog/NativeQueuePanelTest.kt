@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.activity.ComponentActivity
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.DownloadTargetSettingsDto
import cz.stremiooffline.tv.data.RemoteCapabilitiesDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.StreamDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The native copy panel: the exact version then the exact destination, a denied right and a
 *  missing destination told apart, and nothing acting again while the queue call is in flight. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class NativeQueuePanelTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private fun version(id: String, copyable: Boolean = true, target: String? = null) = StreamDto(
    sourceId = id,
    kind = "remote",
    playable = true,
    name = "Version $id",
    capabilities = RemoteCapabilitiesDto(downloadToLibrary = copyable),
    remoteItem = RemoteItemContext(libraryId = "rlibA", itemId = "iA", mediaSourceId = id, progressKey = "k-$id"),
    downloadTarget = target?.let { DownloadTargetSettingsDto(libraryId = it) },
  )

  private fun library(id: String, name: String) = LibraryDto(id = id, name = name, type = "movie", writable = true)

  private val queued = mutableListOf<Pair<String, String>>()
  private var closed = 0

  private fun mount(
    versions: List<StreamDto>,
    libraries: List<LibraryDto>,
    preferred: StreamDto? = null,
    busy: Boolean = false,
  ) {
    compose.setContent {
      NativeQueuePanel(
        versions = versions,
        libraries = libraries,
        preferred = preferred,
        busy = busy,
        onQueue = { stream, libraryId -> queued += stream.sourceId to libraryId },
        onClose = { closed += 1 },
      )
    }
    compose.waitForIdle()
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  @Test
  fun `picks the exact version and then the exact destination`() {
    mount(listOf(version("small"), version("big")), listOf(library("libA", "Films"), library("libB", "Series")))
    // The version step leads; the largest is preselected, so Down lands on it.
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    assertEquals(listOf("big" to "libB"), queued)
  }

  @Test
  fun `a single version goes straight to the destination`() {
    mount(listOf(version("only")), listOf(library("libA", "Films")))
    press(Key.DirectionCenter)
    assertEquals(listOf("only" to "libA"), queued)
  }

  @Test
  fun `a denied native right is named instead of copying anything`() {
    mount(listOf(version("v1", copyable = false)), listOf(library("libA", "Films")))
    compose.onNodeWithTag(TagNativeQueueDenied).assertExists()
    press(Key.DirectionCenter)
    assertEquals(emptyList<Pair<String, String>>(), queued)
    assertEquals(1, closed)
  }

  @Test
  fun `a known but empty destination list is refused, never queued into nowhere`() {
    mount(listOf(version("v1")), emptyList())
    compose.onNodeWithTag(TagNativeQueueNoTargets).assertExists()
    press(Key.DirectionCenter)
    assertEquals(emptyList<Pair<String, String>>(), queued)
    assertEquals(1, closed)
  }

  @Test
  fun `a busy panel holds the destination, the version and Back`() {
    mount(listOf(version("small"), version("big")), listOf(library("libA", "Films")), busy = true)
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(nativeQueueLibraryTag("libA")).assertDoesNotExist()
    press(Key.Back)
    assertEquals(emptyList<Pair<String, String>>(), queued)
    assertEquals(0, closed)
  }

  @Test
  fun `the preferred version leads the choice when it may be copied`() {
    val preferred = version("chosen")
    mount(listOf(version("other"), preferred), listOf(library("libA", "Films")), preferred = preferred)
    // The version step is shown (two copyable versions); the preferred one is already selected.
    compose.onNodeWithTag(nativeQueueVersionTag("chosen")).assertIsSelected()
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    press(Key.DirectionCenter)
    assertEquals(listOf("chosen" to "libA"), queued)
  }

  @Test
  fun `a version the server cannot offer as a copy is not in the choice`() {
    mount(listOf(version("copyable"), version("blocked", copyable = false)), listOf(library("libA", "Films")))
    // Only one copyable version, so the panel opens on the destination directly.
    compose.onNodeWithTag(nativeQueueVersionTag("blocked")).assertDoesNotExist()
    press(Key.DirectionCenter)
    assertEquals(listOf("copyable" to "libA"), queued)
  }

  @Test
  fun `the projected destination leads while the other rows stay selectable`() {
    mount(listOf(version("only", target = "libB")), listOf(library("libA", "Films"), library("libB", "Series")))
    compose.onNodeWithTag(nativeQueueLibraryTag("libB")).assertIsSelected()
    // The projected row holds focus, so OK takes it without another press.
    press(Key.DirectionCenter)
    assertEquals(listOf("only" to "libB"), queued)
  }

  @Test
  fun `a destination the caller does not offer falls back to the first row`() {
    mount(listOf(version("only", target = "lib_gone")), listOf(library("libA", "Films"), library("libB", "Series")))
    compose.onNodeWithTag(nativeQueueLibraryTag("libA")).assertIsSelected()
    press(Key.DirectionCenter)
    assertEquals(listOf("only" to "libA"), queued)
  }

  @Test
  fun `the viewer can still move to another library than the projected one`() {
    mount(listOf(version("only", target = "libB")), listOf(library("libA", "Films"), library("libB", "Series")))
    // The projected row leads; Up moves the focus to the row before it and OK takes that one.
    press(Key.DirectionUp)
    press(Key.DirectionCenter)
    assertEquals(listOf("only" to "libA"), queued)
  }

  /** One addon row the viewer picked: a caller may offer the server's own rule beside the exact
   *  libraries, and the two must be told apart. */
  private fun addonRow(id: String) = StreamDto(sourceId = id, kind = "remote", playable = true, title = "Czech 8 GB")

  private var defaults = 0

  private fun mountAddon(versions: List<StreamDto>, libraries: List<LibraryDto>, realDebrid: Boolean = false) {
    compose.setContent {
      NativeQueuePanel(
        versions = versions,
        libraries = libraries,
        preferred = null,
        realDebridConfigured = realDebrid,
        onQueueDefault = { defaults += 1 },
        onQueue = { stream, libraryId -> queued += stream.sourceId to libraryId },
        onClose = { closed += 1 },
      )
    }
    compose.waitForIdle()
  }

  @Test
  fun `an addon copy leads with the server's own rule and still offers the libraries`() {
    mountAddon(listOf(addonRow("srcA")), listOf(library("libA", "Films"), library("libB", "Series")))

    // The automatic row holds the focus, so OK hands the choice to the server without a target.
    compose.onNodeWithTag(TagNativeQueueDefault).assertIsFocused()
    press(Key.DirectionCenter)
    assertEquals(1, defaults)
    assertTrue(queued.isEmpty())
  }

  @Test
  fun `an addon library row stays selectable as an explicit override`() {
    mountAddon(listOf(addonRow("srcA")), listOf(library("libA", "Films")))
    // Down moves from the automatic row to the exact library; OK takes that one.
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    assertEquals(listOf("srcA" to "libA"), queued)
    assertEquals(0, defaults)
  }

  @Test
  fun `an addon panel with no writable library still offers the server's rule`() {
    mountAddon(listOf(addonRow("srcA")), emptyList())

    compose.onNodeWithTag(TagNativeQueueDefault).assertExists()
    compose.onNodeWithTag(TagNativeQueueNoTargets).assertDoesNotExist()
    press(Key.DirectionCenter)
    assertEquals(1, defaults)
  }

  @Test
  fun `a torrent addon row is refused without debrid`() {
    val torrent = StreamDto(sourceId = "tor1", kind = "torrent", playable = false, title = "Czech 8 GB")
    mountAddon(listOf(torrent), listOf(library("libA", "Films")))
    // Without debrid the row is not copyable, so the panel names the refused right.
    compose.onNodeWithTag(TagNativeQueueDenied).assertExists()
    assertTrue(queued.isEmpty())
  }

  @Test
  fun `a torrent addon row is copyable with debrid configured`() {
    val torrent = StreamDto(sourceId = "tor1", kind = "torrent", playable = false, title = "Czech 8 GB")
    mountAddon(listOf(torrent), listOf(library("libA", "Films")), realDebrid = true)
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    assertEquals(listOf("tor1" to "libA"), queued)
  }
}
