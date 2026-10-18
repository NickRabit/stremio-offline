@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.search

import androidx.activity.ComponentActivity
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.GlobalSearchAliasDto
import cz.stremiooffline.tv.data.GlobalSearchCanonicalDto
import cz.stremiooffline.tv.data.GlobalSearchClusterDto
import cz.stremiooffline.tv.data.GlobalSearchLocatorDto
import cz.stremiooffline.tv.data.GlobalSearchMemberDto
import cz.stremiooffline.tv.data.GlobalSearchMemberPageDto
import cz.stremiooffline.tv.data.GlobalSearchPollDto
import cz.stremiooffline.tv.data.GlobalSearchSnapshotDto
import cz.stremiooffline.tv.data.GlobalSearchSourceDto
import cz.stremiooffline.tv.data.GlobalSearchStartResultDto
import cz.stremiooffline.tv.data.RemoteItemDetailDto
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.VoiceLauncher
import cz.stremiooffline.tv.ui.detail.RemoteDetailData
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class GlobalSearchScreenTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private var catalogOpened: cz.stremiooffline.tv.ui.catalog.CatalogDetailArgs? = null
  private var remoteOpened: RemoteDetailData? = null
  private var libraryOpened: String? = null

  private class Voice {
    val calls = mutableListOf<(String) -> Unit>()
    fun answer(text: String) = calls.last()(text)
  }

  private fun cluster(key: String, vararg members: String, title: String = key) = GlobalSearchClusterDto(
    key = key,
    kind = "movie",
    title = title,
    memberCount = members.size,
    primaryMemberKey = members.first(),
    memberKeys = members.toList(),
  )

  private fun source(
    id: String = "src",
    state: String = "exhausted",
    retryable: Boolean = false,
    hasMore: Boolean = false,
  ) = GlobalSearchSourceDto(
    id = id,
    sourceClass = "catalog",
    label = "Catalog $id",
    state = state,
    retryable = retryable,
    hasMore = hasMore,
  )

  private fun snapshot(
    revision: Int,
    cards: List<GlobalSearchClusterDto>,
    state: String = "complete",
    aliases: List<GlobalSearchAliasDto> = emptyList(),
    unidentified: List<GlobalSearchClusterDto> = emptyList(),
    sources: List<GlobalSearchSourceDto> = listOf(source()),
  ) = GlobalSearchSnapshotDto(
    revision = revision,
    state = state,
    sources = sources,
    clusters = cards,
    unidentified = unidentified,
    aliases = aliases,
  )

  private fun mount(
    api: FakeTvApi,
    voiceAvailable: Boolean = false,
    voiceLauncher: VoiceLauncher? = null,
  ) {
    compose.setContent {
      GlobalSearchScreen(
        api = api,
        onOpenCatalog = { catalogOpened = it },
        onOpenRemote = { remoteOpened = it },
        onOpenLibrary = { libraryOpened = it },
        imageUrl = { null },
        overlayOpen = false,
        voiceAvailable = voiceAvailable,
        voiceLauncher = voiceLauncher,
      )
    }
    compose.waitForIdle()
  }

  private fun start(api: FakeTvApi, cards: List<GlobalSearchClusterDto>, state: String = "complete") {
    api.globalStartHandler = {
      GlobalSearchStartResultDto(id = "gs", snapshot = snapshot(1, cards, state))
    }
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun focus(tag: String) {
    compose.onNodeWithTag(tag).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
  }

  private fun search(query: String = "matrix") {
    focus(TagGlobalSearchField)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagGlobalSearchInput).performTextInput(query)
    compose.onNodeWithTag(TagGlobalSearchInput).performImeAction()
    compose.waitForIdle()
  }

  private fun assertCardBefore(first: String, second: String) {
    val firstBounds = compose.onNodeWithTag(globalSearchCardTag(first)).fetchSemanticsNode().boundsInRoot
    val secondBounds = compose.onNodeWithTag(globalSearchCardTag(second)).fetchSemanticsNode().boundsInRoot
    assertTrue(
      "$first is before $second",
      firstBounds.top < secondBounds.top || firstBounds.top == secondBounds.top && firstBounds.left < secondBounds.left,
    )
  }

  @Test
  fun `typing waits for Done before starting a search`() {
    val api = FakeTvApi()
    mount(api)

    focus(TagGlobalSearchField)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagGlobalSearchInput).performTextInput("matrix")
    compose.waitForIdle()
    assertEquals(0, api.globalStartCalls.size)

    compose.onNodeWithTag(TagGlobalSearchInput).performImeAction()
    compose.waitForIdle()
    assertEquals("matrix", api.globalStartCalls.single().query)
  }

  @Test
  fun `a completed voice result starts the search`() {
    val api = FakeTvApi()
    val voice = Voice()
    mount(api, voiceAvailable = true, voiceLauncher = { voice.calls += it })

    focus(TagGlobalSearchVoice)
    press(Key.DirectionCenter)
    voice.answer("  heat  ")
    compose.waitForIdle()

    assertEquals("heat", api.globalStartCalls.single().query)
  }

  @Test
  fun `appending cards keeps focus on the same anchor`() {
    val api = FakeTvApi()
    start(api, listOf(cluster("c1", "m1", title = "One"), cluster("c2", "m2", title = "Two")))
    val gate = CompletableDeferred<Unit>()
    var next: GlobalSearchPollDto? = null
    api.globalPollHandler = { _, revision ->
      gate.await()
      next.also { next = null } ?: GlobalSearchPollDto(changed = false, revision = revision)
    }
    mount(api)
    search()
    focus(globalSearchCardTag("m1"))

    next = GlobalSearchPollDto(
      changed = true,
      snapshot = snapshot(
        2,
        listOf(cluster("c1", "m1", title = "One"), cluster("c2", "m2", title = "Two"), cluster("c3", "m3", title = "Three")),
      ),
    )
    gate.complete(Unit)
    compose.waitForIdle()

    compose.onNodeWithTag(globalSearchCardTag("m1")).assertIsFocused()
  }

  @Test
  fun `server relevance order is shown until a result card is focused`() {
    val api = FakeTvApi()
    start(api, listOf(cluster("c2", "m2", title = "Two"), cluster("c1", "m1", title = "One")))
    val gate = CompletableDeferred<Unit>()
    var next: GlobalSearchPollDto? = null
    api.globalPollHandler = { _, revision ->
      gate.await()
      next.also { next = null } ?: GlobalSearchPollDto(changed = false, revision = revision)
    }
    mount(api)
    search()
    assertCardBefore("m2", "m1")

    next = GlobalSearchPollDto(
      changed = true,
      snapshot = snapshot(2, listOf(cluster("c1", "m1", title = "One"), cluster("c2", "m2", title = "Two"))),
    )
    gate.complete(Unit)
    compose.waitForIdle()

    assertCardBefore("m1", "m2")
  }

  @Test
  fun `a focused result card stays in place when a later snapshot reorders`() {
    val api = FakeTvApi()
    start(api, listOf(cluster("c2", "m2", title = "Two"), cluster("c1", "m1", title = "One")))
    val gate = CompletableDeferred<Unit>()
    var next: GlobalSearchPollDto? = null
    api.globalPollHandler = { _, revision ->
      gate.await()
      next.also { next = null } ?: GlobalSearchPollDto(changed = false, revision = revision)
    }
    mount(api)
    search()
    focus(globalSearchCardTag("m2"))
    assertCardBefore("m2", "m1")

    next = GlobalSearchPollDto(
      changed = true,
      snapshot = snapshot(2, listOf(cluster("c1", "m1", title = "One"), cluster("c2", "m2", title = "Two"))),
    )
    gate.complete(Unit)
    compose.waitForIdle()

    compose.onNodeWithTag(globalSearchCardTag("m2")).assertIsFocused()
    assertCardBefore("m2", "m1")
  }

  @Test
  fun `a merge keeps focus on the merged card that contains the anchor`() {
    val api = FakeTvApi()
    start(api, listOf(cluster("c1", "m1", title = "One"), cluster("c2", "m2", title = "Two")))
    val gate = CompletableDeferred<Unit>()
    var next: GlobalSearchPollDto? = null
    api.globalPollHandler = { _, revision ->
      gate.await()
      next.also { next = null } ?: GlobalSearchPollDto(changed = false, revision = revision)
    }
    mount(api)
    search()
    focus(globalSearchCardTag("m1"))

    next = GlobalSearchPollDto(
      changed = true,
      snapshot = snapshot(
        2,
        listOf(cluster("c2", "m1", "m2", title = "Merged")),
        aliases = listOf(GlobalSearchAliasDto("c1", "c2")),
      ),
    )
    gate.complete(Unit)
    compose.waitForIdle()

    compose.onNodeWithTag(globalSearchCardTag("m1")).assertIsFocused()
  }

  @Test
  fun `a split keeps focus on the side containing the anchor`() {
    val api = FakeTvApi()
    start(api, listOf(cluster("cOld", "m1", "m2", title = "Both")))
    val gate = CompletableDeferred<Unit>()
    var next: GlobalSearchPollDto? = null
    api.globalPollHandler = { _, revision ->
      gate.await()
      next.also { next = null } ?: GlobalSearchPollDto(changed = false, revision = revision)
    }
    mount(api)
    search()
    focus(globalSearchCardTag("m1"))

    next = GlobalSearchPollDto(
      changed = true,
      snapshot = snapshot(
        2,
        listOf(cluster("cNewB", "m2", title = "Two"), cluster("cNewA", "m1", title = "One")),
        aliases = listOf(GlobalSearchAliasDto("cOld", "cNewB")),
      ),
    )
    gate.complete(Unit)
    compose.waitForIdle()

    compose.onNodeWithTag(globalSearchCardTag("m1")).assertIsFocused()
  }

  @Test
  fun `a partial snapshot leaves focus in the filter row`() {
    val api = FakeTvApi()
    start(api, listOf(cluster("c1", "m1")))
    val gate = CompletableDeferred<Unit>()
    var next: GlobalSearchPollDto? = null
    api.globalPollHandler = { _, revision ->
      gate.await()
      next.also { next = null } ?: GlobalSearchPollDto(changed = false, revision = revision)
    }
    mount(api)
    search()
    focus(globalSearchFilterTag("kind_movie"))

    next = GlobalSearchPollDto(
      changed = true,
      snapshot = snapshot(2, listOf(cluster("c1", "m1"), cluster("c2", "m2")), state = "partial"),
    )
    gate.complete(Unit)
    compose.waitForIdle()

    compose.onNodeWithTag(globalSearchFilterTag("kind_movie")).assertIsFocused()
  }

  @Test
  fun `retry is reachable with the D-pad and calls the source retry`() {
    val api = FakeTvApi()
    api.globalStartHandler = {
      GlobalSearchStartResultDto(
        id = "gs",
        snapshot = snapshot(1, listOf(cluster("c1", "m1")), sources = listOf(source("broken", "failed", retryable = true))),
      )
    }
    mount(api)
    search()

    focus(TagGlobalSearchSourceStrip)
    press(Key.DirectionCenter)
    press(Key.DirectionDown)
    press(Key.DirectionRight)
    compose.onNodeWithTag(globalSearchSourceRetryTag("broken")).assertIsFocused()
    press(Key.DirectionCenter)

    assertEquals(listOf("gs" to "broken"), api.globalRetryCalls)
  }

  @Test
  fun `Back closes the chooser and returns focus to the anchor card`() {
    val api = FakeTvApi()
    start(api, listOf(cluster("c1", "m1", title = "One")))
    api.globalMembersHandler = { _, _, _ ->
      GlobalSearchMemberPageDto(
        clusterKey = "c1",
        members = listOf(
          member("m1"),
          member("m2", locator = GlobalSearchLocatorDto(kind = "local", key = "lib/one", libraryId = "lib", itemKind = "folder")),
        ),
      )
    }
    mount(api)
    search()
    focus(globalSearchCardTag("m1"))
    press(Key.DirectionCenter)
    compose.waitForIdle()
    compose.onNodeWithTag(TagGlobalSearchChooser).assertExists()

    compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()

    compose.onNodeWithTag(TagGlobalSearchChooser).assertDoesNotExist()
    compose.onNodeWithTag(globalSearchCardTag("m1")).assertIsFocused()
  }

  @Test
  fun `a title with a shared id opens its title page without asking`() {
    val api = FakeTvApi()
    start(api, listOf(cluster("c1", "m1", "m2", title = "One")))
    api.globalMembersHandler = { _, _, _ ->
      GlobalSearchMemberPageDto(
        clusterKey = "c1",
        members = listOf(
          member("m1"),
          member("m2", locator = GlobalSearchLocatorDto(kind = "local", key = "lib/one", libraryId = "lib", itemKind = "folder")),
        ),
        canonical = GlobalSearchCanonicalDto("movie", "tt1", "One"),
      )
    }
    mount(api)
    search()
    focus(globalSearchCardTag("m1"))
    press(Key.DirectionCenter)
    compose.waitForIdle()

    compose.onNodeWithTag(TagGlobalSearchChooser).assertDoesNotExist()
    assertEquals("tt1", catalogOpened?.meta?.id)
    assertEquals("movie", catalogOpened?.type)
  }

  @Test
  fun `several catalogues of one addon are one copy that opens directly`() {
    val api = FakeTvApi()
    start(api, listOf(cluster("c1", "m1", title = "One")))
    api.globalMembersHandler = { _, _, _ ->
      GlobalSearchMemberPageDto(
        clusterKey = "c1",
        members = listOf(
          member(
            "m1",
            locator = GlobalSearchLocatorDto(kind = "catalog", addonKey = "a", type = "movie", id = "tt9", catalogId = "films"),
          ),
          member(
            "m2",
            locator = GlobalSearchLocatorDto(kind = "catalog", addonKey = "a", type = "movie", id = "tt9", catalogId = "netflix"),
          ),
        ),
      )
    }
    mount(api)
    search()
    focus(globalSearchCardTag("m1"))
    press(Key.DirectionCenter)
    compose.waitForIdle()

    compose.onNodeWithTag(TagGlobalSearchChooser).assertDoesNotExist()
    assertEquals("tt9", catalogOpened?.meta?.id)
    assertEquals("movie", catalogOpened?.meta?.type)
    assertEquals("Catalog", catalogOpened?.addonName)
  }

  @Test
  fun `a single remote copy is hydrated before its detail opens`() {
    val api = FakeTvApi()
    start(api, listOf(cluster("c1", "m1", title = "One")))
    api.globalMembersHandler = { _, _, _ ->
      GlobalSearchMemberPageDto(
        clusterKey = "c1",
        members = listOf(
          member(
            "m1",
            locator = GlobalSearchLocatorDto(
              kind = "remote",
              libraryId = "lib",
              itemId = "item",
              provider = "jellyfin",
            ),
          ),
        ),
      )
    }
    api.remoteItemValues["lib:item"] = RemoteItemDetailDto(RemoteItemDto(id = "item", name = "One", type = "movie"))
    mount(api)
    search()
    focus(globalSearchCardTag("m1"))
    press(Key.DirectionCenter)
    compose.waitForIdle()

    assertEquals(listOf("lib" to "item"), api.remoteItemRequests)
    assertEquals("jellyfin", remoteOpened?.provider)
    assertEquals("Catalog", remoteOpened?.libraryName)
    assertEquals("item", remoteOpened?.item?.id)
    assertNull(libraryOpened)
  }

  private fun member(
    key: String,
    locator: GlobalSearchLocatorDto = GlobalSearchLocatorDto(kind = "catalog", type = "movie", id = key),
  ) = GlobalSearchMemberDto(
    memberKey = key,
    sourceId = "src",
    sourceClass = "catalog",
    sourceLabel = "Catalog",
    kind = "movie",
    title = "Member $key",
    locator = locator,
  )
}
