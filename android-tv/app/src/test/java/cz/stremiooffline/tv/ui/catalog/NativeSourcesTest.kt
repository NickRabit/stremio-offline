@file:OptIn(ExperimentalCoroutinesApi::class)

package cz.stremiooffline.tv.ui.catalog

import cz.stremiooffline.tv.catalog.Streams
import cz.stremiooffline.tv.data.AddonDto
import cz.stremiooffline.tv.data.AddonManifestDto
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteLibraryDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.StreamSourceDto
import cz.stremiooffline.tv.ui.FakeTvApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The unified coordinator behind a native item's Sources panel: nothing leaves before the panel is
 * opened, every group is asked under the item's exact catalogue identity, the library the item was
 * opened from is never matched again, and one group's failure leaves the others' rows where they
 * were.
 */
class NativeSourcesTest {

  private fun row(sourceId: String, size: String, addonKey: String? = null, addonName: String? = null) = StreamDto(
    sourceId = sourceId,
    kind = "remote",
    playable = true,
    title = "Czech $size",
    addonKey = addonKey,
    addonName = addonName,
  )

  private fun local(path: String) = StreamDto(
    sourceId = "lib1",
    kind = "library",
    playable = true,
    localPath = path,
    libraryName = "Filmy",
  )

  private fun remote(sourceId: String, libraryId: String, itemId: String) = StreamDto(
    sourceId = sourceId,
    kind = "remote",
    playable = true,
    name = "Version $sourceId",
    remoteItem = RemoteItemContext(libraryId = libraryId, itemId = itemId, mediaSourceId = sourceId, progressKey = "remote:$libraryId:$itemId"),
  )

  private fun library(id: String, name: String) = RemoteLibraryDto(id = id, name = name, provider = "jellyfin")

  private fun addon(key: String, name: String) =
    AddonDto(key = key, manifest = AddonManifestDto(id = "$key.id", name = name))

  private fun TestScope.coordinator(
    api: FakeTvApi,
    identity: Pair<String, String> = "movie" to "tt1",
    nameHint: String? = "Heat",
    origin: String = "rlibA",
  ): Pair<NativeSources, CoroutineScope> {
    val scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
    return NativeSources(api, api, origin, identity, nameHint) to scope
  }

  @Test
  fun `nothing is asked until the panel is opened`() = runTest {
    val api = FakeTvApi().apply {
      settingsValue = SettingsResponse(audioLanguage = "en")
      streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
      addonStreams["movie:tt1|alpha"] = listOf(row("srcA", "8 GB"))
      localStreamsValues["movie:tt1"] = listOf(local("Filmy/Heat.mkv"))
      remoteLibrariesValue = listOf(library("rlibA", "Filmy"), library("rlibB", "Serialy"))
      remoteMatchValues["rlibB|movie|tt1"] = listOf(remote("ms9", "rlibB", "iB"))
    }
    val (sources, _) = coordinator(api)

    advanceUntilIdle()

    assertTrue(api.streamSourcesRequests.isEmpty())
    assertTrue(api.streamsRequests.isEmpty())
    assertTrue(api.localStreamsRequests.isEmpty())
    assertEquals(0, api.remoteLibrariesCalls)
    assertEquals(0, api.remoteMatchRequests.size)
    assertEquals(0, api.settingsCalls)
    assertFalse(sources.state.asking)
    assertTrue(sources.state.addonRows.isEmpty())
  }

  @Test
  fun `opening asks every group under the item's own identity and never the origin library`() = runTest {
    val api = FakeTvApi().apply {
      settingsValue = SettingsResponse(audioLanguage = "en", realDebridConfigured = true)
      addonsValue = listOf(addon("alpha", "Alpha"))
      streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"), StreamSourceDto("beta", "Beta"))
      addonStreams["movie:tt1|alpha"] = listOf(row("srcA", "8 GB"))
      addonStreams["movie:tt1|beta"] = listOf(row("srcB", "4 GB"))
      localStreamsValues["movie:tt1"] = listOf(local("Filmy/Heat.mkv"))
      remoteLibrariesValue = listOf(library("rlibA", "Filmy"), library("rlibB", "Serialy"))
      remoteMatchValues["rlibB|movie|tt1"] = listOf(remote("ms9", "rlibB", "iB"))
    }
    val (sources, scope) = coordinator(api)
    sources.open(scope)

    advanceUntilIdle()

    val state = sources.state
    assertEquals(listOf("movie:tt1"), api.streamSourcesRequests)
    assertEquals(listOf("movie:tt1|alpha", "movie:tt1|beta"), api.streamsRequests)
    // Every addon request names its provider: one unfiltered call would load every addon at once.
    assertTrue(api.streamsRequests.all { it.contains("|") })
    assertEquals(listOf("movie:tt1"), api.localStreamsRequests)
    // The origin library's versions are already in hand, so it is never matched again.
    assertEquals(listOf("rlibB|movie|tt1"), api.remoteMatchRequests)
    assertEquals(listOf("Heat"), api.remoteMatchHints)
    assertEquals(listOf("Filmy/Heat.mkv"), state.local.map { it.localPath })
    assertEquals(listOf("rlibB"), state.remoteGroups.map { it.libraryId })
    assertEquals(listOf("srcA", "srcB"), state.addonRows.map { it.sourceId })
    assertTrue(state.realDebridConfigured)
    assertTrue(state.failedLabels.isEmpty())
    assertFalse(state.asking)
  }

  @Test
  fun `an episode is asked under its parent series identity and name`() = runTest {
    val api = FakeTvApi().apply {
      streamSourcesValues["series:tt5:1:2"] = listOf(StreamSourceDto("alpha", "Alpha"))
      localStreamsValues["series:tt5:1:2"] = emptyList()
      remoteLibrariesValue = listOf(library("rlibA", "Filmy"), library("rlibB", "Serialy"))
    }
    val (sources, scope) = coordinator(api, identity = "series" to "tt5:1:2", nameHint = "Show")
    sources.open(scope)

    advanceUntilIdle()

    assertEquals(listOf("series:tt5:1:2"), api.streamSourcesRequests)
    assertEquals(listOf("series:tt5:1:2"), api.localStreamsRequests)
    assertEquals(listOf("rlibB|series|tt5:1:2"), api.remoteMatchRequests)
    // The provider's name filter takes the series name, never the episode's own.
    assertEquals(listOf("Show"), api.remoteMatchHints)
  }

  @Test
  fun `at most two addon providers are asked at a time`() = runTest {
    val keys = listOf("alpha", "beta", "gamma", "delta")
    val api = FakeTvApi().apply {
      streamSourcesValues["movie:tt1"] = keys.map { StreamSourceDto(it, it.replaceFirstChar { c -> c.uppercase() }) }
      keys.forEach { key ->
        addonStreams["movie:tt1|$key"] = listOf(row("src-$key", "8 GB"))
        streamsGates["movie:tt1|$key"] = CompletableDeferred()
      }
      remoteLibrariesValue = emptyList()
    }
    val (sources, scope) = coordinator(api)
    sources.open(scope)
    runCurrent()

    assertEquals(2, api.streamsRequests.size)
    assertEquals(2, api.streamsPeakInFlight)

    keys.forEach { key ->
      api.streamsGates.remove("movie:tt1|$key")?.complete(Unit)
      runCurrent()
    }
    advanceUntilIdle()

    assertEquals(4, api.streamsRequests.size)
    assertTrue(api.streamsPeakInFlight <= 2)
    assertEquals(4, sources.state.addonRows.size)
    assertFalse(sources.state.asking)
  }

  @Test
  fun `at most two remote libraries are matched at a time`() = runTest {
    val libraries = (1..4).map { library("rlib$it", "Library $it") }
    val api = FakeTvApi().apply {
      streamSourcesValues["movie:tt1"] = emptyList()
      remoteLibrariesValue = listOf(library("rlibA", "Filmy")) + libraries
      libraries.forEach { remoteMatchGates["${it.id}|movie|tt1"] = CompletableDeferred() }
    }
    val (sources, scope) = coordinator(api)
    sources.open(scope)
    runCurrent()

    assertEquals(2, api.remoteMatchRequests.size)
    assertEquals(2, api.remoteMatchesPeakInFlight)

    libraries.forEach { library ->
      api.remoteMatchGates.remove("${library.id}|movie|tt1")?.complete(Unit)
      runCurrent()
    }
    advanceUntilIdle()

    assertEquals(4, api.remoteMatchRequests.size)
    assertTrue(api.remoteMatchesPeakInFlight <= 2)
    assertFalse(sources.state.asking)
  }

  @Test
  fun `the matched groups keep the configured library order however their answers arrive`() = runTest {
    val api = FakeTvApi().apply {
      streamSourcesValues["movie:tt1"] = emptyList()
      remoteLibrariesValue = listOf(library("rlibA", "Filmy"), library("rlibB", "Serialy"), library("rlibC", "Dokumenty"))
      // The first configured library is the slow one, the second answers at once.
      remoteMatchGates["rlibB|movie|tt1"] = CompletableDeferred()
      remoteMatchValues["rlibC|movie|tt1"] = listOf(remote("ms9", "rlibC", "iC"))
    }
    val (sources, scope) = coordinator(api)
    sources.open(scope)
    runCurrent()

    assertEquals(listOf("rlibC"), sources.state.remoteGroups.map { it.libraryId })

    api.remoteMatchValues["rlibB|movie|tt1"] = listOf(remote("ms8", "rlibB", "iB"))
    api.remoteMatchGates.remove("rlibB|movie|tt1")?.complete(Unit)
    advanceUntilIdle()

    assertEquals(listOf("rlibB", "rlibC"), sources.state.remoteGroups.map { it.libraryId })
  }

  @Test
  fun `the library list is given up at its own deadline and never matched`() = runTest {
    val api = FakeTvApi().apply {
      streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
      addonStreams["movie:tt1|alpha"] = listOf(row("srcA", "8 GB"))
      localStreamsValues["movie:tt1"] = listOf(local("Filmy/Heat.mkv"))
      remoteLibrariesValue = listOf(library("rlibB", "Serialy"))
      remoteLibrariesGate = CompletableDeferred()
    }
    val (sources, scope) = coordinator(api)
    sources.open(scope)
    runCurrent()
    assertTrue(sources.state.asking)

    advanceTimeBy(REMOTE_DISCOVERY_TIMEOUT_MS + 1)
    runCurrent()

    assertTrue(api.remoteMatchRequests.isEmpty())
    assertTrue(sources.state.unnamedFailure)
    assertFalse(sources.state.asking)
    // The groups that answer independently are still there: the item's rows stay usable.
    assertEquals(listOf("Filmy/Heat.mkv"), sources.state.local.map { it.localPath })
    assertEquals(listOf("srcA"), sources.state.addonRows.map { it.sourceId })
  }

  @Test
  fun `a match that never answers is given up at the group deadline and named`() = runTest {
    val api = FakeTvApi().apply {
      streamSourcesValues["movie:tt1"] = emptyList()
      remoteLibrariesValue = listOf(library("rlibB", "Serialy"))
      remoteMatchGates["rlibB|movie|tt1"] = CompletableDeferred()
    }
    val (sources, scope) = coordinator(api)
    sources.open(scope)
    runCurrent()

    advanceTimeBy(REMOTE_MATCH_TIMEOUT_MS + 1)
    runCurrent()

    assertEquals(listOf("jellyfin · Serialy"), sources.state.failedLabels)
    assertFalse(sources.state.asking)
    assertTrue(sources.state.remoteGroups.isEmpty())
  }

  @Test
  fun `a retry asks only the groups that owe an answer`() = runTest {
    val api = FakeTvApi().apply {
      streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"), StreamSourceDto("beta", "Beta"))
      addonStreams["movie:tt1|alpha"] = listOf(row("srcA", "8 GB"))
      streamFailures["movie:tt1|beta"] = ApiFailure.Unreachable
      localStreamsValues["movie:tt1"] = listOf(local("Filmy/Heat.mkv"))
      remoteLibrariesValue = listOf(library("rlibB", "Serialy"), library("rlibC", "Dokumenty"))
      remoteMatchValues["rlibC|movie|tt1"] = listOf(remote("ms9", "rlibC", "iC"))
      remoteMatchFailures += "rlibB|movie|tt1"
    }
    val (sources, scope) = coordinator(api)
    sources.open(scope)
    advanceUntilIdle()

    assertEquals(listOf("jellyfin · Serialy", "Beta"), sources.state.failedLabels)
    assertEquals(listOf("srcA"), sources.state.addonRows.map { it.sourceId })
    assertEquals(listOf("rlibC"), sources.state.remoteGroups.map { it.libraryId })

    // Both failures heal; the groups that already answered are not asked again.
    api.streamFailures.remove("movie:tt1|beta")
    api.addonStreams["movie:tt1|beta"] = listOf(row("srcB", "4 GB"))
    api.remoteMatchFailures.remove("rlibB|movie|tt1")
    api.remoteMatchValues["rlibB|movie|tt1"] = listOf(remote("ms8", "rlibB", "iB"))
    sources.retry(scope)
    advanceUntilIdle()

    assertEquals(2, api.streamsRequests.count { it == "movie:tt1|beta" })
    assertEquals(1, api.streamsRequests.count { it == "movie:tt1|alpha" })
    assertEquals(1, api.streamSourcesRequests.size)
    assertEquals(1, api.localStreamsRequests.size)
    assertEquals(1, api.remoteLibrariesCalls)
    assertEquals(2, api.remoteMatchRequests.count { it == "rlibB|movie|tt1" })
    assertEquals(1, api.remoteMatchRequests.count { it == "rlibC|movie|tt1" })
    assertEquals(listOf("srcA", "srcB"), sources.state.addonRows.map { it.sourceId })
    assertEquals(listOf("rlibB", "rlibC"), sources.state.remoteGroups.map { it.libraryId })
    assertTrue(sources.state.failedLabels.isEmpty())
    assertFalse(sources.state.asking)
  }

  @Test
  fun `a failed local lookup is its own retryable failure and keeps the other rows`() = runTest {
    val api = FakeTvApi().apply {
      streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
      addonStreams["movie:tt1|alpha"] = listOf(row("srcA", "8 GB"))
      localStreamsError = ApiError(ApiFailure.Unreachable)
      remoteLibrariesValue = emptyList()
    }
    val (sources, scope) = coordinator(api)
    sources.open(scope)
    advanceUntilIdle()

    assertTrue(sources.state.unnamedFailure)
    assertTrue(sources.state.failedLabels.isEmpty())
    assertEquals(listOf("srcA"), sources.state.addonRows.map { it.sourceId })

    api.localStreamsError = null
    api.localStreamsValues["movie:tt1"] = listOf(local("Filmy/Heat.mkv"))
    sources.retry(scope)
    advanceUntilIdle()

    assertEquals(2, api.localStreamsRequests.size)
    assertEquals(1, api.streamSourcesRequests.size)
    assertEquals(listOf("Filmy/Heat.mkv"), sources.state.local.map { it.localPath })
    assertFalse(sources.state.unnamedFailure)
  }

  @Test
  fun `rows are deduped by a nonblank source id and named by their provider`() = runTest {
    val api = FakeTvApi().apply {
      streamSourcesValues["movie:tt1"] =
        listOf(StreamSourceDto("alpha", "Alpha"), StreamSourceDto("beta", "Beta"))
      addonStreams["movie:tt1|alpha"] = listOf(row("small", "2 GB"), row("dup", "1 GB"), row("", "3 GB"))
      addonStreams["movie:tt1|beta"] = listOf(row("dup", "9 GB"), row("big", "16 GB"))
      remoteLibrariesValue = emptyList()
    }
    val (sources, scope) = coordinator(api)
    sources.open(scope)
    advanceUntilIdle()

    // Blank identifiers cannot name playable or queueable registered resources.
    assertEquals(listOf("small", "dup", "big"), sources.state.addonRows.map { it.sourceId })
    val big = sources.state.addonRows.first { it.sourceId == "big" }
    assertEquals("beta", big.addonKey)
    assertEquals("Beta", big.addonName)
  }

  @Test
  fun `one provider's rows stay while the other provider answers nothing`() = runTest {
    val api = FakeTvApi().apply {
      streamSourcesValues["movie:tt1"] =
        listOf(StreamSourceDto("alpha", "Alpha"), StreamSourceDto("beta", "Beta"))
      addonStreams["movie:tt1|alpha"] = listOf(row("srcA", "8 GB"))
      addonStreams["movie:tt1|beta"] = emptyList()
      remoteLibrariesValue = emptyList()
    }
    val (sources, scope) = coordinator(api)
    sources.open(scope)
    advanceUntilIdle()

    assertEquals(listOf("srcA"), sources.state.addonRows.map { it.sourceId })
    assertTrue(sources.state.failedLabels.isEmpty())
    assertFalse(sources.state.asking)
  }

  @Test
  fun `a retry leaves an empty answer alone and asks only what failed`() = runTest {
    val api = FakeTvApi().apply {
      streamSourcesValues["movie:tt1"] =
        listOf(StreamSourceDto("alpha", "Alpha"), StreamSourceDto("beta", "Beta"))
      addonStreams["movie:tt1|alpha"] = emptyList()
      streamFailures["movie:tt1|beta"] = ApiFailure.Unreachable
      // The viewer's own copies and every other library answered nothing: an empty answer is an
      // answer, and neither is asked a second time.
      localStreamsValues["movie:tt1"] = emptyList()
      remoteLibrariesValue = listOf(library("rlibB", "Serialy"))
    }
    val (sources, scope) = coordinator(api)
    sources.open(scope)
    advanceUntilIdle()

    assertEquals(listOf("Beta"), sources.state.failedLabels)

    api.streamFailures.remove("movie:tt1|beta")
    api.addonStreams["movie:tt1|beta"] = listOf(row("srcB", "4 GB"))
    sources.retry(scope)
    advanceUntilIdle()

    assertEquals(1, api.streamSourcesRequests.size)
    assertEquals(1, api.localStreamsRequests.size)
    assertEquals(1, api.remoteLibrariesCalls)
    assertEquals(1, api.streamsRequests.count { it == "movie:tt1|alpha" })
    assertEquals(2, api.streamsRequests.count { it == "movie:tt1|beta" })
    assertEquals(listOf("srcB"), sources.state.addonRows.map { it.sourceId })
    assertTrue(sources.state.failedLabels.isEmpty())
  }

  @Test
  fun `a provider that names no key is never asked`() = runTest {
    val api = FakeTvApi().apply {
      streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"), StreamSourceDto("", "Nameless"))
      addonStreams["movie:tt1|alpha"] = listOf(row("srcA", "8 GB"))
      // A blank key would mean "every addon at once" on the wire, which no panel may ask for.
      streamsValues["movie:tt1"] = listOf(row("all", "1 GB"))
      remoteLibrariesValue = emptyList()
    }
    val (sources, scope) = coordinator(api)
    sources.open(scope)
    advanceUntilIdle()

    assertEquals(listOf("movie:tt1|alpha"), api.streamsRequests)
    assertTrue(api.streamsRequests.none { it == "movie:tt1" })
    assertEquals(listOf("srcA"), sources.state.addonRows.map { it.sourceId })
    assertFalse(sources.state.asking)
  }

  @Test
  fun `the settings read is a group of its own and is retried alone`() = runTest {
    val api = FakeTvApi().apply {
      settingsValue = SettingsResponse(audioLanguage = "cs", realDebridConfigured = true)
      settingsReadFailure = ApiFailure.Unreachable
      streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
      addonStreams["movie:tt1|alpha"] = listOf(row("srcA", "8 GB"))
      localStreamsValues["movie:tt1"] = emptyList()
      remoteLibrariesValue = listOf(library("rlibB", "Serialy"))
      remoteMatchValues["rlibB|movie|tt1"] = listOf(remote("ms9", "rlibB", "iB"))
    }
    val (sources, scope) = coordinator(api)
    sources.open(scope)
    advanceUntilIdle()

    // The failed settings read is a failure of the panel even though every row answered.
    assertFalse(sources.state.realDebridConfigured)
    assertTrue(sources.state.unnamedFailure)
    assertEquals(listOf("srcA"), sources.state.addonRows.map { it.sourceId })

    api.settingsReadFailure = null
    sources.retry(scope)
    advanceUntilIdle()

    assertEquals(2, api.settingsCalls)
    // Only the settings read was asked again: the rows, the providers and the libraries stay.
    assertEquals(1, api.streamSourcesRequests.size)
    assertEquals(1, api.streamsRequests.size)
    assertEquals(1, api.localStreamsRequests.size)
    assertEquals(1, api.remoteLibrariesCalls)
    assertTrue(sources.state.realDebridConfigured)
    assertFalse(sources.state.unnamedFailure)
  }

  @Test
  fun `the addon list is a group of its own and is retried alone`() = runTest {
    val api = FakeTvApi().apply {
      settingsValue = SettingsResponse(audioLanguage = "cs")
      addonsValue = listOf(addon("beta", "Beta"), addon("alpha", "Alpha"))
      streamSourcesValues["movie:tt1"] =
        listOf(StreamSourceDto("alpha", "Alpha"), StreamSourceDto("beta", "Beta"))
      addonStreams["movie:tt1|alpha"] = listOf(row("srcA", "8 GB", addonName = "Alpha"))
      addonStreams["movie:tt1|beta"] = listOf(row("srcB", "2 GB", addonName = "Beta"))
      localStreamsValues["movie:tt1"] = emptyList()
      remoteLibrariesValue = emptyList()
      addonsFailure = ApiFailure.Unreachable
    }
    val (sources, scope) = coordinator(api)
    sources.open(scope)
    advanceUntilIdle()

    assertTrue(sources.state.addons.isEmpty())
    assertTrue(sources.state.unnamedFailure)
    assertEquals(listOf("srcA", "srcB"), sources.state.addonRows.map { it.sourceId })

    api.addonsFailure = null
    sources.retry(scope)
    advanceUntilIdle()

    assertEquals(listOf("Beta", "Alpha"), sources.state.addons.map { it.manifest.name })
    assertEquals(1, api.streamSourcesRequests.size)
    assertEquals(1, api.streamsRequests.count { it == "movie:tt1|alpha" })
    assertFalse(sources.state.unnamedFailure)
  }

  @Test
  fun `an addon's own message is kept as an attributed notice, never as a row`() = runTest {
    val notice = StreamDto(sourceId = "n1", kind = "unsupported", title = "No stream for this one")
    val api = FakeTvApi().apply {
      streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
      addonStreams["movie:tt1|alpha"] = listOf(row("srcA", "8 GB"), notice)
      localStreamsValues["movie:tt1"] = emptyList()
      remoteLibrariesValue = emptyList()
    }
    val (sources, scope) = coordinator(api)
    sources.open(scope)
    advanceUntilIdle()

    // The message is a notice of its own, attributed to the provider that wrote it, and it never
    // becomes a row the viewer could pick or a default.
    assertEquals(listOf("No stream for this one"), sources.state.notices.map { it.title })
    assertEquals(listOf("Alpha"), sources.state.notices.map { it.addonName })
    assertEquals(listOf("srcA"), sources.state.addonRows.map { it.sourceId })
  }

  @Test
  fun `two libraries offering the same version id stay two rows`() = runTest {
    val api = FakeTvApi().apply {
      streamSourcesValues["movie:tt1"] = emptyList()
      localStreamsValues["movie:tt1"] = emptyList()
      remoteLibrariesValue = listOf(library("rlibB", "Serialy"), library("rlibC", "Dokumenty"))
      remoteMatchValues["rlibB|movie|tt1"] = listOf(remote("v1", "rlibB", "iB"))
      remoteMatchValues["rlibC|movie|tt1"] = listOf(remote("v1", "rlibC", "iC"))
    }
    val (sources, scope) = coordinator(api)
    sources.open(scope)
    advanceUntilIdle()

    assertEquals(listOf("rlibB", "rlibC"), sources.state.remoteGroups.map { it.libraryId })
    val versions = sources.state.remoteGroups.flatMap { it.streams }
    assertEquals(listOf("v1", "v1"), versions.map { it.sourceId })
    // The same version id in two libraries is two versions: one identity, one row each.
    assertEquals(2, Streams.deduped(versions).size)
    assertTrue(Streams.rowIdentity(versions[0]) != Streams.rowIdentity(versions[1]))
  }

  @Test
  fun `an empty library list is not a failure`() = runTest {
    val api = FakeTvApi().apply {
      streamSourcesValues["movie:tt1"] = emptyList()
      remoteLibrariesValue = listOf(library("rlibA", "Filmy"))
    }
    val (sources, scope) = coordinator(api)
    sources.open(scope)
    advanceUntilIdle()

    assertFalse(sources.state.unnamedFailure)
    assertTrue(sources.state.failedLabels.isEmpty())
    assertFalse(sources.state.asking)
    assertTrue(api.remoteMatchRequests.isEmpty())
  }

  @Test
  fun `reopening the same item asks nothing and keeps what answered`() = runTest {
    val api = FakeTvApi().apply {
      streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
      addonStreams["movie:tt1|alpha"] = listOf(row("srcA", "8 GB"))
      localStreamsValues["movie:tt1"] = listOf(local("Filmy/Heat.mkv"))
      remoteLibrariesValue = listOf(library("rlibB", "Serialy"))
      remoteMatchValues["rlibB|movie|tt1"] = listOf(remote("ms9", "rlibB", "iB"))
    }
    val (sources, scope) = coordinator(api)
    sources.open(scope)
    advanceUntilIdle()
    val calls = api.streamsRequests.size

    sources.open(scope)
    advanceUntilIdle()

    assertEquals(calls, api.streamsRequests.size)
    assertEquals(1, api.streamSourcesRequests.size)
    assertEquals(1, api.localStreamsRequests.size)
    assertEquals(1, api.remoteLibrariesCalls)
    assertEquals(1, api.remoteMatchRequests.size)
    assertEquals(listOf("srcA"), sources.state.addonRows.map { it.sourceId })
    assertEquals(listOf("rlibB"), sources.state.remoteGroups.map { it.libraryId })
  }

  @Test
  fun `an answer for an item the viewer left never lands`() = runTest {
    val api = FakeTvApi().apply {
      streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
      streamsGates["movie:tt1|alpha"] = CompletableDeferred()
      remoteLibrariesValue = emptyList()
    }
    val (sources, scope) = coordinator(api)
    sources.open(scope)
    runCurrent()
    assertTrue(sources.state.asking)

    scope.cancel()
    api.streamsGates.remove("movie:tt1|alpha")?.complete(Unit)
    advanceUntilIdle()

    assertTrue(sources.state.addonRows.isEmpty())
    assertTrue(sources.state.asking)
  }

  @Test
  fun `retry never duplicates metadata reads still in flight`() = runTest {
    val gate = CompletableDeferred<Unit>()
    val api = object : FakeTvApi() {
      override suspend fun addons(): List<AddonDto> {
        addonsCalls++
        gate.await()
        return addonsValue
      }
    }.apply {
      settingsReadGate = gate
      streamSourcesFailures["movie:tt1"] = ApiFailure.Unreachable
    }
    val (sources, scope) = coordinator(api)
    sources.open(scope)
    runCurrent()
    sources.retry(scope)
    runCurrent()
    assertEquals(1, api.settingsCalls)
    assertEquals(1, api.addonsCalls)
    gate.complete(Unit)
    advanceUntilIdle()
    assertEquals(1, api.settingsCalls)
    assertEquals(1, api.addonsCalls)
    scope.cancel()
  }

  @Test
  fun `a disabled remote library is never matched`() = runTest {
    val api = FakeTvApi().apply {
      remoteLibrariesValue = listOf(library("disabled", "Hidden").copy(enabled = false))
    }
    val (sources, scope) = coordinator(api)
    sources.open(scope)
    advanceUntilIdle()
    assertTrue(api.remoteMatchRequests.isEmpty())
    scope.cancel()
  }

}
