@file:OptIn(ExperimentalCoroutinesApi::class)

package cz.stremiooffline.tv.ui.player

import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.BehaviorHintsDto
import cz.stremiooffline.tv.data.LibraryTitleDto
import cz.stremiooffline.tv.data.RemoteLibraryDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.StreamSourceDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.OfferedSources
import cz.stremiooffline.tv.ui.detail.PlayTarget
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The list a play that started from the library offers: the title its file is bound to, asked
 *  from the addons the way the catalogue detail asks for one of its own titles. */
class LibraryPlaySourcesTest {

  private fun target(path: String) = PlayTarget(key = "file:$path", title = "Heat", resume = true, path = path)

  private fun library(path: String) = StreamDto(
    sourceId = "lib1",
    kind = "library",
    playable = true,
    localPath = path,
    libraryName = "Filmy",
    behaviorHints = BehaviorHintsDto(filename = path.substringAfterLast('/')),
  )

  private fun alpha(sourceId: String = "srcA") =
    StreamDto(sourceId = sourceId, kind = "remote", playable = true, title = "Czech 8 GB", addonName = "Alpha")

  @Test
  fun `a bound movie file offers the local copy and the addon rows`() = runTest {
    val api = FakeTvApi()
    api.settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", realDebridConfigured = true)
    api.libraryTitleValues["Filmy/Heat/Heat.mkv"] = LibraryTitleDto("movie", "tt1", name = "Heat")
    api.streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
    api.addonStreams["movie:tt1|alpha"] = listOf(alpha())
    api.localStreamsValues["movie:tt1"] = listOf(library("Filmy/Heat/Heat.mkv"))
    val reports = mutableListOf<OfferedSources>()

    LibraryPlaySources(api).load(target("Filmy/Heat/Heat.mkv")) { reports += it }

    val rows = reports.last().streams
    assertEquals(listOf("Filmy/Heat/Heat.mkv", "srcA"), rows.map { it.localPath ?: it.sourceId })
    assertEquals(listOf("library", "remote"), rows.map { it.kind })
    assertFalse(reports.last().loading)
    // The panel may draw the local copy before the addon answered, so at least one report said
    // it was still asking.
    assertTrue(reports.any { it.loading })
    assertEquals(listOf("movie:tt1"), api.streamSourcesRequests)
    assertEquals(listOf("movie:tt1"), api.localStreamsRequests)
  }

  @Test
  fun `at most two providers and two libraries are asked at a time`() = runTest {
    val api = FakeTvApi()
    api.settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en")
    api.libraryTitleValues["Filmy/Heat/Heat.mkv"] = LibraryTitleDto("movie", "tt1", name = "Heat")
    val providers = listOf("alpha", "beta", "gamma", "delta")
    api.streamSourcesValues["movie:tt1"] = providers.map { StreamSourceDto(it, it.replaceFirstChar { c -> c.uppercase() }) }
    providers.forEach { key ->
      api.addonStreams["movie:tt1|$key"] = listOf(alpha("src-$key"))
      api.streamsGates["movie:tt1|$key"] = CompletableDeferred()
    }
    val libraries = (1..4).map { RemoteLibraryDto(id = "rlib$it", name = "Library $it", provider = "jellyfin") }
    api.remoteLibrariesValue = libraries
    libraries.forEach { api.remoteMatchGates["${it.id}|movie|tt1"] = CompletableDeferred() }
    val reports = mutableListOf<OfferedSources>()

    val job = launch { LibraryPlaySources(api).load(target("Filmy/Heat/Heat.mkv")) { reports += it } }
    runCurrent()

    // The two categories are budgeted on their own: neither lane holds the other back.
    assertEquals(2, api.streamsInFlight)
    assertEquals(2, api.remoteMatchesInFlight)
    assertTrue(api.streamsRequests.isNotEmpty() && api.streamsRequests.all { it.contains("|") })

    providers.forEach { key ->
      api.streamsGates.remove("movie:tt1|$key")?.complete(Unit)
      runCurrent()
    }
    libraries.forEach { api.remoteMatchGates.remove("${it.id}|movie|tt1")?.complete(Unit) }
    advanceUntilIdle()
    job.join()

    assertEquals(4, api.streamsRequests.size)
    assertTrue(api.streamsPeakInFlight <= 2)
    assertTrue(api.remoteMatchesPeakInFlight <= 2)
    assertEquals(4, api.remoteMatchRequests.size)
    // The four providers' rows are all there; the four libraries matched nothing.
    assertEquals(listOf("src-alpha", "src-beta", "src-gamma", "src-delta"), reports.last().streams.map { it.sourceId })
    assertFalse(reports.last().loading)
  }

  @Test
  fun `a disabled library is never matched and a blank provider key is never asked`() = runTest {
    val api = FakeTvApi()
    api.settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en")
    api.libraryTitleValues["Filmy/Heat/Heat.mkv"] = LibraryTitleDto("movie", "tt1", name = "Heat")
    // A blank key would mean "every addon at once" on the wire, which this loader never asks for.
    api.streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"), StreamSourceDto("", "Nameless"))
    api.addonStreams["movie:tt1|alpha"] = listOf(alpha())
    api.streamsValues["movie:tt1"] = listOf(alpha("srcAll"))
    api.localStreamsValues["movie:tt1"] = emptyList()
    api.remoteLibrariesValue = listOf(
      RemoteLibraryDto(id = "rlibOff", name = "Off", provider = "jellyfin", enabled = false),
      RemoteLibraryDto(id = "rlibOn", name = "On", provider = "jellyfin"),
    )
    api.remoteMatchValues["rlibOn|movie|tt1"] = listOf(alpha("ms9"))
    val reports = mutableListOf<OfferedSources>()

    LibraryPlaySources(api).load(target("Filmy/Heat/Heat.mkv")) { reports += it }

    assertEquals(listOf("movie:tt1|alpha"), api.streamsRequests)
    assertEquals(listOf("rlibOn|movie|tt1"), api.remoteMatchRequests)
    // The matched library row leads the addon row, as the shared list orders them.
    assertEquals(listOf("ms9", "srcA"), reports.last().streams.map { it.sourceId })
  }

  /** The unbound/snapshot cases must not narrow the file flow: a bound filesystem play still
   *  gathers its own copy, the addons and the other libraries, with no snapshot in hand. */
  @Test
  fun `a bound filesystem play with no snapshot still gathers every group`() = runTest {
    val api = FakeTvApi()
    api.settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en")
    api.libraryTitleValues["Filmy/Heat/Heat.mkv"] = LibraryTitleDto("movie", "tt1", name = "Heat")
    api.streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
    api.addonStreams["movie:tt1|alpha"] = listOf(alpha())
    api.localStreamsValues["movie:tt1"] = listOf(library("Filmy/Heat/Heat.mkv"))
    api.remoteLibrariesValue = listOf(RemoteLibraryDto(id = "rlibB", name = "Serialy", provider = "jellyfin"))
    api.remoteMatchValues["rlibB|movie|tt1"] = listOf(
      StreamDto(
        sourceId = "ms9",
        kind = "remote",
        playable = true,
        name = "Version ms9",
        remoteItem = cz.stremiooffline.tv.data.RemoteItemContext(
          libraryId = "rlibB",
          itemId = "iB",
          mediaSourceId = "ms9",
          progressKey = "remote:rlibB:iB",
        ),
      ),
    )
    val reports = mutableListOf<OfferedSources>()

    LibraryPlaySources(api).load(target("Filmy/Heat/Heat.mkv")) { reports += it }

    // The viewer's copy leads, the other library's version and the addon row follow, and the list
    // is only final once every group answered.
    assertEquals(
      listOf("Filmy/Heat/Heat.mkv", "ms9", "srcA"),
      reports.last().streams.map { it.localPath ?: it.sourceId },
    )
    assertFalse(reports.last().loading)
    assertEquals(listOf("rlibB|movie|tt1"), api.remoteMatchRequests)
    assertTrue(reports.any { it.loading })
  }

  @Test
  fun `a bound series file asks for the video id of its episode`() = runTest {
    val api = FakeTvApi()
    api.settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en")
    api.libraryTitleValues["Shows/Show/S01/Show.S01E02.mkv"] =
      LibraryTitleDto("series", "tt5", videoId = "tt5:1:2", name = "Show")
    api.streamSourcesValues["series:tt5:1:2"] = listOf(StreamSourceDto("alpha", "Alpha"))
    api.addonStreams["series:tt5:1:2|alpha"] = listOf(alpha())
    api.localStreamsValues["series:tt5:1:2"] = listOf(library("Shows/Show/S01/Show.S01E02.mkv"))
    val reports = mutableListOf<OfferedSources>()

    LibraryPlaySources(api).load(target("Shows/Show/S01/Show.S01E02.mkv")) { reports += it }

    assertEquals(listOf("series:tt5:1:2"), api.streamSourcesRequests)
    assertEquals(listOf("series:tt5:1:2"), api.localStreamsRequests)
    assertEquals(listOf("Shows/Show/S01/Show.S01E02.mkv", "srcA"), reports.last().streams.map { it.localPath ?: it.sourceId })
  }

  @Test
  fun `a bound series file asks the remote libraries with the series name`() = runTest {
    val api = FakeTvApi()
    api.settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en")
    api.remoteLibrariesValue = listOf(RemoteLibraryDto(id = "rlibA", name = "Filmy", provider = "jellyfin"))
    api.libraryTitleValues["Shows/Show/S01/Show.S01E02.mkv"] =
      LibraryTitleDto("series", "tt5", videoId = "tt5:1:2", name = "Show")

    LibraryPlaySources(api).load(target("Shows/Show/S01/Show.S01E02.mkv")) { }

    // The episode's own id is asked for, but the provider filter is the parent series name.
    assertEquals(listOf("rlibA|series|tt5:1:2"), api.remoteMatchRequests)
    assertEquals(listOf("Show"), api.remoteMatchHints.filterNotNull())
  }

  @Test
  fun `a file with no binding reports nothing and asks nothing`() = runTest {
    val api = FakeTvApi()
    val reports = mutableListOf<OfferedSources>()

    LibraryPlaySources(api).load(target("Filmy/Loose.mkv")) { reports += it }

    assertTrue(reports.isEmpty())
    assertEquals(listOf("Filmy/Loose.mkv"), api.libraryTitleRequests)
    assertTrue(api.streamSourcesRequests.isEmpty())
    assertTrue(api.localStreamsRequests.isEmpty())
    assertEquals(0, api.settingsCalls)
    assertEquals(0, api.addonsCalls)
  }

  @Test
  fun `a failed lookup reports nothing`() = runTest {
    val api = FakeTvApi()
    api.libraryTitleValues["Filmy/Heat/Heat.mkv"] = LibraryTitleDto("movie", "tt1", name = "Heat")
    api.libraryTitleFailure = ApiError(ApiFailure.Unreachable)
    val reports = mutableListOf<OfferedSources>()

    LibraryPlaySources(api).load(target("Filmy/Heat/Heat.mkv")) { reports += it }

    assertTrue(reports.isEmpty())
    assertTrue(api.streamSourcesRequests.isEmpty())
    assertTrue(api.localStreamsRequests.isEmpty())
  }

  @Test
  fun `the local copy is reported while the addon still owes its list`() = runTest {
    val api = FakeTvApi()
    api.settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en")
    api.libraryTitleValues["Filmy/Heat/Heat.mkv"] = LibraryTitleDto("movie", "tt1", name = "Heat")
    api.streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
    api.addonStreams["movie:tt1|alpha"] = listOf(alpha())
    api.localStreamsValues["movie:tt1"] = listOf(library("Filmy/Heat/Heat.mkv"))
    val gate = CompletableDeferred<Unit>()
    api.streamsGates["movie:tt1|alpha"] = gate
    val reports = mutableListOf<OfferedSources>()

    val job = launch { LibraryPlaySources(api).load(target("Filmy/Heat/Heat.mkv")) { reports += it } }
    runCurrent()

    assertEquals(listOf("Filmy/Heat/Heat.mkv"), reports.last().streams.map { it.localPath })
    assertTrue(reports.last().loading)

    gate.complete(Unit)
    advanceUntilIdle()
    job.join()

    assertEquals(listOf("Filmy/Heat/Heat.mkv", "srcA"), reports.last().streams.map { it.localPath ?: it.sourceId })
    assertFalse(reports.last().loading)
  }

  @Test
  fun `a snapshot target discovers nothing at all`() = runTest {
    val api = FakeTvApi()
    api.libraryTitleValues["Filmy/Heat/Heat.mkv"] = LibraryTitleDto("movie", "tt1", name = "Heat")
    val reports = mutableListOf<OfferedSources>()

    LibraryPlaySources(api).load(
      PlayTarget(
        key = "movie:tt1",
        title = "It",
        resume = true,
        sourceId = "srcA",
        subtitleType = "movie",
        subtitleTarget = "tt1",
        initialSources = listOf(alpha()),
      ),
    ) { reports += it }

    assertTrue(reports.isEmpty())
    assertTrue(api.libraryTitleRequests.isEmpty())
    assertTrue(api.localStreamsRequests.isEmpty())
    assertTrue(api.streamSourcesRequests.isEmpty())
    assertTrue(api.remoteMatchRequests.isEmpty())
    assertEquals(0, api.settingsCalls)
    assertEquals(0, api.addonsCalls)
  }

  @Test
  fun `a snapshot target with a path still discovers nothing`() = runTest {
    val api = FakeTvApi()
    api.libraryTitleValues["Filmy/Heat/Heat.mkv"] = LibraryTitleDto("movie", "tt1", name = "Heat")
    val reports = mutableListOf<OfferedSources>()

    LibraryPlaySources(api).load(
      PlayTarget(
        key = "movie:tt1",
        title = "It",
        resume = true,
        path = "Filmy/Heat/Heat.mkv",
        sourceId = "srcA",
        initialSources = listOf(alpha()),
      ),
    ) { reports += it }

    assertTrue(reports.isEmpty())
    assertTrue(api.libraryTitleRequests.isEmpty())
    assertTrue(api.localStreamsRequests.isEmpty())
    assertTrue(api.streamSourcesRequests.isEmpty())
  }
}
