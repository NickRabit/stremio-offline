@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.BehaviorHintsDto
import cz.stremiooffline.tv.data.InspectionDto
import cz.stremiooffline.tv.data.InspectionTrackDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.FakeTvApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class CatalogDetailInspectionTest {
  @get:Rule val compose = createComposeRule()

  private fun settings() = SettingsResponse(
    uiLanguage = "en",
    audioLanguage = "en",
    streamSort = "recommended",
    realDebridConfigured = true,
  )

  private fun movieArgs() =
    CatalogDetailArgs(MetaDto(id = "tt1", type = "movie", name = "It", description = "A film"), "Cinemeta", "movie")

  private fun stream(
    sourceId: String,
    name: String,
    size: Double? = null,
    kind: String = "remote",
    playable: Boolean = true,
    audioLanguages: List<String> = emptyList(),
    provider: String? = null,
    remoteItem: RemoteItemContext? = null,
  ) = StreamDto(
    sourceId = sourceId,
    kind = kind,
    playable = playable,
    name = name,
    behaviorHints = size?.let { BehaviorHintsDto(videoSize = it) },
    audioLanguages = audioLanguages,
    provider = provider,
    remoteItem = remoteItem,
  )

  private fun inspection(vararg audio: String): InspectionDto = InspectionDto(
    audioTracks = audio.map { InspectionTrackDto(language = it) },
    subtitleTracks = emptyList(),
  )

  private fun mount(api: FakeTvApi) {
    compose.setContent {
      CatalogDetailScreen(
        api = api,
        args = movieArgs(),
        imageUrl = { null },
        onPlay = {},
        onBack = {},
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

  private fun focusFromLeft(tag: String) {
    repeat(6) {
      if (focused(tag)) return
      press(Key.DirectionRight)
    }
    compose.onNodeWithTag(tag).assertIsFocused()
  }

  private fun openSources() {
    focusFromLeft(TagCatalogSources)
    press(Key.DirectionCenter)
    compose.mainClock.advanceTimeByFrame()
    compose.waitForIdle()
    compose.onNodeWithTag(TagSourcesPanel).assertExists()
  }

  private fun settle(frames: Long = 2) {
    compose.mainClock.advanceTimeByFrame()
    repeat((frames - 1).coerceAtLeast(0).toInt()) { compose.mainClock.advanceTimeByFrame() }
    compose.waitForIdle()
  }

  private fun chosenText(): String =
    compose.onNodeWithTag(TagCatalogChosenSource)
      .fetchSemanticsNode()
      .config[SemanticsProperties.Text]
      .joinToString(" ") { it.text }

  @Test
  fun `waits 500 ms and shows the probed audio in the chosen source block`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamsValues["movie:tt1"] = listOf(stream("s1", "Film.1080p"))
    api.inspectValues["s1"] = inspection("en", "cs")
    compose.mainClock.autoAdvance = false
    mount(api)
    compose.waitForIdle()

    compose.mainClock.advanceTimeBy(400)
    compose.waitForIdle()
    assertEquals(emptyList<String>(), api.inspectCalls)

    compose.mainClock.advanceTimeBy(100)
    settle()
    assertEquals(listOf("s1"), api.inspectCalls)
    val fromFile = ApplicationProvider.getApplicationContext<android.content.Context>().getString(R.string.detail_tech_from_file)
    val text = chosenText()
    assertTrue(text.contains("English, Czech"))
    assertTrue(text.contains(fromFile))
  }

  @Test
  fun `D-pad changes the version and only the last quick pick is read`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamsValues["movie:tt1"] = listOf(
      stream("first", "Alpha", size = 3_000.0, audioLanguages = listOf("en")),
      stream("second", "Beta", size = 2_000.0, audioLanguages = listOf("en")),
      stream("third", "Gamma", size = 1_000.0, audioLanguages = listOf("en")),
    )
    api.inspectValues["first"] = inspection("de")
    api.inspectValues["second"] = inspection("en")
    api.inspectValues["third"] = inspection("de")
    compose.mainClock.autoAdvance = false
    mount(api)
    compose.waitForIdle()

    openSources()
    assertEquals(emptyList<String>(), api.inspectCalls)
    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    assertEquals(emptyList<String>(), api.inspectCalls)

    openSources()
    compose.onNodeWithTag(sourceRowTag(1)).assertIsFocused()
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    assertEquals(emptyList<String>(), api.inspectCalls)

    compose.mainClock.advanceTimeBy(450)
    compose.waitForIdle()
    assertEquals(emptyList<String>(), api.inspectCalls)
    compose.mainClock.advanceTimeBy(100)
    settle()
    assertEquals(listOf("third"), api.inspectCalls)
    assertTrue(chosenText().contains("German"))
  }

  @Test
  fun `local media-server and uncached debrid sources are not inspected`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    var revision by mutableIntStateOf(0)
    val sources = listOf(
      stream("local", "Local - film.mkv", kind = "library"),
      stream(
        "remote",
        "Jellyfin copy",
        provider = "jellyfin",
        remoteItem = RemoteItemContext("library", "item", "media", "progress"),
      ),
      stream("debrid", "[RD download] Torrentio"),
    )
    api.streamsValues["movie:tt1"] = listOf(sources[0])
    compose.mainClock.autoAdvance = false
    compose.setContent {
      key(revision) {
        CatalogDetailScreen(
          api = api,
          args = movieArgs(),
          imageUrl = { null },
          onPlay = {},
          onBack = {},
        )
      }
    }
    compose.waitForIdle()
    for (index in sources.indices) {
      if (index > 0) {
        api.streamsValues["movie:tt1"] = listOf(sources[index])
        compose.runOnIdle {
          revision += 1
        }
        compose.waitForIdle()
      }
      compose.mainClock.advanceTimeBy(600)
      settle()
    }
    assertEquals(emptyList<String>(), api.inspectCalls)
  }

  @Test
  fun `a failed read leaves the listing audio without a probing note`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamsValues["movie:tt1"] = listOf(stream("s1", "Film", audioLanguages = listOf("cs")))
    api.inspectFailure = cz.stremiooffline.tv.data.ApiFailure.Generic
    compose.mainClock.autoAdvance = false
    mount(api)
    compose.waitForIdle()

    compose.mainClock.advanceTimeBy(500)
    settle()
    val probing = ApplicationProvider.getApplicationContext<android.content.Context>().getString(R.string.sources_probing)
    val text = chosenText()
    assertTrue(text.contains("Czech"))
    assertFalse(text.contains(probing))
  }
}
