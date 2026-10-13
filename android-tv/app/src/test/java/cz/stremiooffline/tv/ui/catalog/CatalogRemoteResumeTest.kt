@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteItemStateDto
import cz.stremiooffline.tv.data.RemoteLibraryDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Matched remote sources resume from their per-user local remote-state row. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class CatalogRemoteResumeTest {

  @get:Rule val compose = createComposeRule()

  private val played = mutableListOf<PlayTarget>()

  private fun settings() =
    SettingsResponse(uiLanguage = "en", audioLanguage = "en", streamSort = "recommended", realDebridConfigured = true)

  private fun remoteStream(sourceId: String, libraryId: String) = StreamDto(
    sourceId = sourceId,
    kind = "remote",
    playable = true,
    name = sourceId,
    provider = "jellyfin",
    libraryName = "Filmy",
    remoteItem = RemoteItemContext(
      libraryId = libraryId,
      itemId = "iA",
      mediaSourceId = sourceId,
      progressKey = "remote:$libraryId:iA",
    ),
  )

  private fun movieArgs() = CatalogDetailArgs(MetaDto(id = "tt1", type = "movie", name = "It"), "Cinemeta", "movie")

  /** Two versions of one matched item, `a1` leading so it is the panel's default. */
  private fun twoVersions(api: FakeTvApi) {
    api.settingsValue = settings()
    api.remoteLibrariesValue = listOf(RemoteLibraryDto(id = "rlibA", name = "Filmy", provider = "jellyfin"))
    api.remoteMatchValues["rlibA|movie|tt1"] = listOf(remoteStream("a1", "rlibA"), remoteStream("a2", "rlibA"))
  }

  private fun mount(api: FakeTvApi, restoreToken: () -> Int = { 0 }) {
    compose.setContent {
      CatalogDetailScreen(
        api = api,
        args = movieArgs(),
        imageUrl = { null },
        onPlay = { played += it },
        onBack = {},
        restoreToken = restoreToken(),
      )
    }
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun focused(tag: String): Boolean =
    compose.onAllNodes(isFocused()).fetchSemanticsNodes()
      .any { it.config.getOrElse(SemanticsProperties.TestTag) { "" } == tag }

  private fun openSources() {
    repeat(6) {
      if (!focused(TagCatalogSources)) press(Key.DirectionRight)
    }
    compose.onNodeWithTag(TagCatalogSources).assertIsFocused()
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSourcesPanel).assertExists()
  }

  /** Opens the panel and picks the source row at [index]; the panel then hands the remote to Play. */
  private fun chooseSourceRow(index: Int) {
    openSources()
    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()
    repeat(index) { press(Key.DirectionDown) }
    compose.onNodeWithTag(sourceRowTag(index)).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitForIdle()
  }

  private fun barTextCount(): Int =
    compose.onAllNodes(hasText("watched", substring = true)).fetchSemanticsNodes().size

  @Test
  fun `the exact version that stored the position resumes from the remote row`() {
    val api = FakeTvApi()
    twoVersions(api)
    // The catalogue has its own progress, but a remote version never reads it.
    api.progressValues["movie:tt1"] = ProgressDto(position = 1200.0, duration = 3600.0)
    api.remoteStateValue = RemoteItemStateDto(position = 900.0, duration = 1800.0, watched = false, mediaSourceId = "a1")
    mount(api)
    compose.waitUntil(5_000) { api.remoteMatchRequests.contains("rlibA|movie|tt1") }
    compose.waitForIdle()

    // The leading version is the active one, so its own row decides the label and the bar.
    compose.onNodeWithTag(TagCatalogPrimary).assertTextContains("Resume")
    compose.onNodeWithTag(TagCatalogStartOver).assertExists()
    assertEquals(1, barTextCount())

    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
    press(Key.DirectionCenter)

    val target = played.single()
    assertEquals("remote:rlibA:iA", target.key)
    assertTrue(target.resume)
    assertEquals("rlibA", target.remoteItem?.libraryId)
    assertEquals("iA", target.remoteItem?.itemId)
    assertEquals("a1", target.remoteItem?.mediaSourceId)
    assertEquals(listOf("a1", "a2"), target.remoteSources.map { it.sourceId })
  }

  @Test
  fun `a watched version offers Play from the start despite catalogue progress`() {
    val api = FakeTvApi()
    twoVersions(api)
    api.progressValues["movie:tt1"] = ProgressDto(position = 1200.0, duration = 3600.0)
    api.remoteStateValue = RemoteItemStateDto(position = 900.0, duration = 1800.0, watched = true, mediaSourceId = "a1")
    mount(api)
    compose.waitUntil(5_000) { api.remoteMatchRequests.contains("rlibA|movie|tt1") }
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogPrimary).assertTextContains("Play")
    compose.onNodeWithTag(TagCatalogStartOver).assertDoesNotExist()
    assertEquals(0, barTextCount())

    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
    press(Key.DirectionCenter)
    assertFalse(played.single().resume)
    assertEquals("a1", played.single().remoteItem?.mediaSourceId)
  }

  @Test
  fun `a version other than the stored one offers Play from the start`() {
    val api = FakeTvApi()
    twoVersions(api)
    api.progressValues["movie:tt1"] = ProgressDto(position = 1200.0, duration = 3600.0)
    // The stored row belongs to `a1`; the viewer picks `a2`, which has no position of its own.
    api.remoteStateValue = RemoteItemStateDto(position = 900.0, duration = 1800.0, watched = false, mediaSourceId = "a1")
    mount(api)
    compose.waitUntil(5_000) { api.remoteMatchRequests.contains("rlibA|movie|tt1") }
    compose.waitForIdle()

    chooseSourceRow(1)

    compose.onNodeWithTag(TagCatalogPrimary).assertTextContains("Play")
    compose.onNodeWithTag(TagCatalogStartOver).assertDoesNotExist()
    assertEquals(0, barTextCount())

    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
    press(Key.DirectionCenter)
    assertFalse(played.single().resume)
    assertEquals("a2", played.single().remoteItem?.mediaSourceId)
  }

  @Test
  fun `switching versions and the restore token each re-read the remote row`() {
    val api = FakeTvApi()
    twoVersions(api)
    api.remoteStateValue = RemoteItemStateDto(position = 900.0, duration = 1800.0, watched = false, mediaSourceId = "a1")
    val token = mutableStateOf(0)
    mount(api) { token.value }
    compose.waitUntil(5_000) { api.remoteMatchRequests.contains("rlibA|movie|tt1") }
    compose.waitForIdle()

    chooseSourceRow(0)
    compose.onNodeWithTag(TagCatalogPrimary).assertTextContains("Resume")

    // Same identity, a fresh answer: the restore token must read it again.
    api.remoteStateValue = RemoteItemStateDto(position = 900.0, duration = 1800.0, watched = true, mediaSourceId = "a1")
    compose.runOnIdle { token.value = 1 }
    compose.waitForIdle()
    compose.onNodeWithTag(TagCatalogPrimary).assertTextContains("Play")
    compose.onNodeWithTag(TagCatalogStartOver).assertDoesNotExist()

    // A different version is a different identity, so its own row is read before it is judged.
    api.remoteStateValue = RemoteItemStateDto(position = 900.0, duration = 1800.0, watched = false, mediaSourceId = "a2")
    chooseSourceRow(1)
    compose.onNodeWithTag(TagCatalogPrimary).assertTextContains("Resume")
    compose.onNodeWithTag(TagCatalogStartOver).assertExists()

    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
    press(Key.DirectionCenter)
    assertTrue(played.single().resume)
    assertEquals("a2", played.single().remoteItem?.mediaSourceId)
  }

  @Test
  fun `a failed remote read offers Play with no bar`() {
    val api = FakeTvApi()
    twoVersions(api)
    api.progressValues["movie:tt1"] = ProgressDto(position = 1200.0, duration = 3600.0)
    api.remoteStateValue = RemoteItemStateDto(position = 900.0, duration = 1800.0, watched = false, mediaSourceId = "a1")
    api.remoteStateFailure = ApiError(ApiFailure.Generic)
    mount(api)
    compose.waitUntil(5_000) { api.remoteMatchRequests.contains("rlibA|movie|tt1") }
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogPrimary).assertTextContains("Play")
    compose.onNodeWithTag(TagCatalogStartOver).assertDoesNotExist()
    assertEquals(0, barTextCount())

    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
    press(Key.DirectionCenter)
    assertFalse(played.single().resume)
  }

  @Test
  fun `a remote version hides the catalogue Forget action`() {
    val api = FakeTvApi()
    twoVersions(api)
    api.progressValues["movie:tt1"] = ProgressDto(position = 40.0, duration = 120.0)
    api.remoteStateValue = RemoteItemStateDto(position = 900.0, duration = 1800.0, watched = false, mediaSourceId = "a1")
    mount(api)
    compose.waitUntil(5_000) { api.remoteMatchRequests.contains("rlibA|movie|tt1") }
    compose.waitForIdle()

    // The active row is remote, so the catalogue's own Forget is not offered.
    compose.onNodeWithTag(TagCatalogForget).assertDoesNotExist()
  }
}
