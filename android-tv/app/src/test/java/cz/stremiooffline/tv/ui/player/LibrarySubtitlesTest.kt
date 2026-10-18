package cz.stremiooffline.tv.ui.player

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import cz.stremiooffline.tv.data.AddonSubtitleDto
import cz.stremiooffline.tv.data.LibraryTitleDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A library file and a media-server copy take the addon subtitles of the title they are bound to. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class LibrarySubtitlesTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private val addonSubtitle = AddonSubtitleDto(subtitleId = "sid-cs", lang = "cs", addonName = "OpenSubtitles v3")

  private fun play(api: FakeTvApi, target: PlayTarget) {
    compose.setContent { PlayerScreen(api = api, target = target, onExit = {}) }
    compose.waitUntil(5_000) { api.startedSubtitleIds.isNotEmpty() }
    compose.waitForIdle()
  }

  @Test
  fun `a bound library film asks the subtitle addons for its title`() {
    val api = FakeTvApi().apply {
      settingsValue = SettingsResponse(subtitleLanguage = "cs")
      subtitlesValue = listOf(addonSubtitle)
      libraryTitleValues["Filmy/Heat.mkv"] = LibraryTitleDto(type = "movie", id = "mpa:sosac:heat", name = "Heat")
    }
    play(api, PlayTarget(key = "file:Filmy/Heat.mkv", title = "Heat", resume = false, path = "Filmy/Heat.mkv"))
    compose.waitUntil(5_000) { api.subtitlesRequests.isNotEmpty() }
    assertEquals(listOf("movie" to "mpa:sosac:heat"), api.subtitlesRequests)
    // The account's Czech subtitle fills the gap the file left once the addon answered.
    compose.waitUntil(5_000) { api.subtitleTextRequests.any { it.first == "sid-cs" } }
  }

  @Test
  fun `a bound library episode asks under the show's id with its season and episode`() {
    val api = FakeTvApi().apply {
      subtitlesValue = listOf(addonSubtitle)
      libraryTitleValues["Serialy/S01E02.mkv"] = LibraryTitleDto(type = "series", id = "tt0096697", name = "Simpsonovi", videoId = "tt0096697:1:2")
    }
    play(api, PlayTarget(key = "file:Serialy/S01E02.mkv", title = "Simpsonovi", resume = false, path = "Serialy/S01E02.mkv"))
    compose.waitUntil(5_000) { api.subtitlesRequests.isNotEmpty() }
    assertEquals(listOf("series" to "tt0096697:1:2"), api.subtitlesRequests)
  }

  @Test
  fun `an unbound file asks nothing`() {
    val api = FakeTvApi().apply { subtitlesValue = listOf(addonSubtitle) }
    play(api, PlayTarget(key = "file:Loose.mkv", title = "Loose", resume = false, path = "Loose.mkv"))
    assertEquals(emptyList<Pair<String, String>>(), api.subtitlesRequests)
    assertEquals(emptyList<String>(), api.startedSubtitleIds.first())
  }

  @Test
  fun `a media-server copy keeps its own subtitles and adds the addon ones of its title`() {
    val context = RemoteItemContext(libraryId = "rlibA", itemId = "iA", mediaSourceId = "ms1", progressKey = "rk")
    val version = StreamDto(
      sourceId = "ms1", kind = "remote", playable = true, remoteItem = context,
      subtitles = listOf(AddonSubtitleDto("own-en", "en", "server")),
    )
    val api = GatedSubtitlesApi().apply { subtitlesValue = listOf(addonSubtitle) }
    play(api, PlayTarget(
      key = "rk", title = "Heat", resume = false, sourceId = "ms1",
      subtitleType = "movie", subtitleTarget = "tt0113277", remoteItem = context, remoteSources = listOf(version),
    ))
    // The copy starts with its own subtitle while the subtitle addons are still answering.
    assertEquals(listOf("own-en"), api.startedSubtitleIds.first())
    assertEquals(listOf("movie" to "tt0113277"), api.subtitlesRequests)
    compose.runOnIdle { api.gate.complete(Unit) }
    compose.waitUntil(5_000) { api.answered }
  }

  @Test
  fun `a slow subtitle addon does not delay a library file`() {
    val api = GatedSubtitlesApi().apply {
      libraryTitleValues["Filmy/Heat.mkv"] = LibraryTitleDto(type = "movie", id = "tt0113277", name = "Heat")
    }
    play(api, PlayTarget(key = "file:Filmy/Heat.mkv", title = "Heat", resume = false, path = "Filmy/Heat.mkv"))
    assertEquals(listOf("src:Filmy/Heat.mkv"), api.startedSources)
    compose.runOnIdle { api.gate.complete(Unit) }
  }

  /** A subtitle addon that answers only once the test lets it. */
  private class GatedSubtitlesApi : FakeTvApi() {
    val gate = CompletableDeferred<Unit>()
    @Volatile var answered = false

    override suspend fun subtitles(type: String, id: String): List<AddonSubtitleDto> {
      subtitlesRequests += type to id
      gate.await()
      answered = true
      return subtitlesValue
    }
  }
}
