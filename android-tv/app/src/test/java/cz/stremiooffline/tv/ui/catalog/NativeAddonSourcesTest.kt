@file:OptIn(ExperimentalCoroutinesApi::class)

package cz.stremiooffline.tv.ui.catalog

import cz.stremiooffline.tv.data.AddonDto
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
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
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The explicit addon discovery: nothing leaves before the viewer presses, one provider answers
 *  only its own key, and an answer for an item the viewer left never lands. */
class NativeAddonSourcesTest {

  /** Every endpoint this code must not touch throws: a call that was never meant to happen is a
   *  failure, never a manufactured empty answer. */
  private class StrictFake : FakeTvApi() {
    val calls = mutableListOf<String>()
    var gate: CompletableDeferred<Unit>? = null

    override suspend fun settings(): SettingsResponse {
      calls += "settings"
      return settingsValue
    }

    override suspend fun addons(): List<AddonDto> {
      calls += "addons"
      throw ApiError(ApiFailure.Generic)
    }

    override suspend fun streamSources(type: String, id: String): List<StreamSourceDto> {
      calls += "streamSources:$type:$id"
      gate?.await()
      return streamSourcesValues["$type:$id"] ?: throw ApiError(ApiFailure.NotFound)
    }

    override suspend fun streams(type: String, id: String, addon: String?): List<StreamDto> {
      calls += "streams:$type:$id:${addon ?: "*"}"
      gate?.await()
      // An unfiltered call would load every addon at once: the panel never makes one.
      if (addon.isNullOrEmpty()) throw ApiError(ApiFailure.Generic)
      return addonStreams["$type:$id|$addon"] ?: throw ApiError(ApiFailure.NotFound)
    }

    override suspend fun localStreams(type: String, id: String): List<StreamDto> {
      calls += "localStreams:$type:$id"
      throw ApiError(ApiFailure.Generic)
    }
  }

  private fun row(sourceId: String, size: String, addonKey: String? = null, addonName: String? = null) = StreamDto(
    sourceId = sourceId,
    kind = "remote",
    playable = true,
    title = "Czech $size",
    addonKey = addonKey,
    addonName = addonName,
  )

  @Test
  fun `nothing is asked until the viewer presses`() = runTest {
    val api = StrictFake()
    api.streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
    val sources = NativeAddonSources(api, "movie" to "tt1")
    runCurrent()

    assertEquals(AddonDiscovery.Idle, sources.discovery)
    assertTrue(api.calls.isEmpty())
    assertEquals(emptyList<StreamDto>(), sources.rows)
  }

  @Test
  fun `discovery asks the item's own request and names its providers`() = runTest {
    val api = StrictFake()
    api.streamSourcesValues["series:tt5:1:2"] = listOf(StreamSourceDto("alpha", "Alpha"), StreamSourceDto("beta", "Beta"))
    val sources = NativeAddonSources(api, "series" to "tt5:1:2")

    sources.discover(this)
    advanceUntilIdle()

    assertEquals(listOf("settings", "streamSources:series:tt5:1:2"), api.calls)
    assertEquals(AddonDiscovery.Ready, sources.discovery)
    assertEquals(listOf("alpha", "beta"), sources.providers.map { it.key })
    // The providers are named, but not one of them has been asked for anything yet.
    assertTrue(api.calls.none { it.startsWith("streams:") })
  }

  @Test
  fun `no provider at all is its own empty answer`() = runTest {
    val api = StrictFake()
    api.streamSourcesValues["movie:tt1"] = emptyList()
    val sources = NativeAddonSources(api, "movie" to "tt1")

    sources.discover(this)
    advanceUntilIdle()

    assertEquals(AddonDiscovery.Empty, sources.discovery)
  }

  @Test
  fun `a failed discovery leaves nothing loaded`() = runTest {
    val api = StrictFake()
    val sources = NativeAddonSources(api, "movie" to "tt1")

    sources.discover(this)
    advanceUntilIdle()

    assertEquals(AddonDiscovery.Failed, sources.discovery)
  }

  @Test
  fun `a provider is asked for its own key alone`() = runTest {
    val api = StrictFake()
    api.streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"), StreamSourceDto("beta", "Beta"))
    api.addonStreams["movie:tt1|alpha"] = listOf(row("srcA", "8 GB"))
    api.addonStreams["movie:tt1|beta"] = listOf(row("srcB", "4 GB"))
    val sources = NativeAddonSources(api, "movie" to "tt1")
    sources.discover(this)
    advanceUntilIdle()

    sources.loadProvider(this, "alpha")
    advanceUntilIdle()

    assertEquals(listOf("streams:movie:tt1:alpha"), api.calls.filter { it.startsWith("streams:") })
    assertEquals(listOf("srcA"), sources.rows.map { it.sourceId })
    assertEquals(AddonProviderLoad.Loaded, sources.providerState("alpha")?.load)
    assertNull(sources.providerState("beta"))
  }

  @Test
  fun `a duplicate pending press shares one call`() = runTest {
    val api = StrictFake()
    api.streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
    api.gate = CompletableDeferred()
    val sources = NativeAddonSources(api, "movie" to "tt1")

    sources.discover(this)
    runCurrent()
    sources.discover(this)
    runCurrent()
    assertEquals(1, api.calls.count { it.startsWith("streamSources:") })

    api.gate?.complete(Unit)
    api.gate = null
    advanceUntilIdle()
    assertEquals(AddonDiscovery.Ready, sources.discovery)
  }

  @Test
  fun `a second press while a provider is in flight shares one call`() = runTest {
    val api = StrictFake()
    api.streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
    api.addonStreams["movie:tt1|alpha"] = listOf(row("srcA", "8 GB"))
    val sources = NativeAddonSources(api, "movie" to "tt1")
    sources.discover(this)
    advanceUntilIdle()

    api.gate = CompletableDeferred()
    sources.loadProvider(this, "alpha")
    runCurrent()
    sources.loadProvider(this, "alpha")
    runCurrent()
    assertEquals(1, api.calls.count { it.startsWith("streams:") })

    api.gate?.complete(Unit)
    api.gate = null
    advanceUntilIdle()
    assertEquals(listOf("srcA"), sources.rows.map { it.sourceId })
  }

  @Test
  fun `one failed provider leaves the other's rows and keeps its own failure`() = runTest {
    val api = StrictFake()
    api.streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"), StreamSourceDto("beta", "Beta"))
    api.addonStreams["movie:tt1|alpha"] = listOf(row("srcA", "8 GB"))
    val sources = NativeAddonSources(api, "movie" to "tt1")
    sources.discover(this)
    advanceUntilIdle()

    sources.loadProvider(this, "alpha")
    sources.loadProvider(this, "beta")
    advanceUntilIdle()

    assertEquals(listOf("srcA"), sources.rows.map { it.sourceId })
    assertEquals(AddonProviderLoad.Loaded, sources.providerState("alpha")?.load)
    assertEquals(AddonProviderLoad.Failed, sources.providerState("beta")?.load)
  }

  @Test
  fun `an empty provider keeps its own state and the other's rows`() = runTest {
    val api = StrictFake()
    api.streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"), StreamSourceDto("beta", "Beta"))
    api.addonStreams["movie:tt1|alpha"] = listOf(row("srcA", "8 GB"))
    api.addonStreams["movie:tt1|beta"] = emptyList()
    val sources = NativeAddonSources(api, "movie" to "tt1")
    sources.discover(this)
    advanceUntilIdle()

    sources.loadProvider(this, "alpha")
    sources.loadProvider(this, "beta")
    advanceUntilIdle()

    assertEquals(AddonProviderLoad.Empty, sources.providerState("beta")?.load)
    assertEquals(listOf("srcA"), sources.rows.map { it.sourceId })
  }

  @Test
  fun `rows are deduped by a nonblank source id, sorted largest first and named by their provider`() = runTest {
    val api = StrictFake()
    api.streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"), StreamSourceDto("beta", "Beta"))
    api.addonStreams["movie:tt1|alpha"] = listOf(row("small", "2 GB"), row("dup", "1 GB"), row("", "3 GB", addonName = "Alpha"))
    api.addonStreams["movie:tt1|beta"] = listOf(row("dup", "9 GB"), row("big", "16 GB"))
    val sources = NativeAddonSources(api, "movie" to "tt1")
    sources.discover(this)
    advanceUntilIdle()

    sources.loadProvider(this, "alpha")
    sources.loadProvider(this, "beta")
    advanceUntilIdle()

    // Blank identifiers cannot name playable or queueable registered resources.
    assertEquals(listOf("big", "small", "dup"), sources.rows.map { it.sourceId })
    val big = sources.rows.first { it.sourceId == "big" }
    assertEquals("beta", big.addonKey)
    assertEquals("Beta", big.addonName)
  }

  @Test
  fun `an answer for an item the viewer left never lands`() = runTest {
    val api = StrictFake()
    api.streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
    api.gate = CompletableDeferred()
    val item = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
    val first = NativeAddonSources(api, "movie" to "tt1")

    first.discover(item)
    runCurrent()
    assertEquals(AddonDiscovery.Loading, first.discovery)

    item.cancel()
    api.gate?.complete(Unit)
    advanceUntilIdle()

    // The dropped item never moved on, and the answer never reached another item's list.
    assertEquals(AddonDiscovery.Loading, first.discovery)
    assertEquals(listOf("settings", "streamSources:movie:tt1"), api.calls)
    val second = NativeAddonSources(api, "movie" to "tt2")
    assertEquals(AddonDiscovery.Idle, second.discovery)
    assertEquals(emptyList<StreamDto>(), second.rows)
  }
}
