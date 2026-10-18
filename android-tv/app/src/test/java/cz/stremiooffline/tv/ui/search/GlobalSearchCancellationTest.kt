@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.search

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.ApiClient
import cz.stremiooffline.tv.data.CookieStore
import cz.stremiooffline.tv.data.GlobalSearchMemberPageDto
import cz.stremiooffline.tv.data.GlobalSearchPollDto
import cz.stremiooffline.tv.data.GlobalSearchStartDto
import cz.stremiooffline.tv.data.GlobalSearchStartResultDto
import cz.stremiooffline.tv.data.ServerAddress
import cz.stremiooffline.tv.data.SessionPersistence
import cz.stremiooffline.tv.ui.FakeTvApi
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.CopyOnWriteArrayList
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class GlobalSearchCancellationTest {

  @get:Rule val compose = createComposeRule()

  private val server = MockWebServer()

  @After
  fun shutdown() {
    server.shutdown()
  }

  @Test
  fun `leaving the screen cancels an in-flight poll call`() {
    server.start()
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
    val canceled = AtomicBoolean(false)
    val paths = CopyOnWriteArrayList<String>()
    val http = OkHttpClient.Builder()
      .addInterceptor { chain ->
        paths += chain.request().url.encodedPath
        chain.proceed(chain.request())
      }
      .eventListenerFactory {
        object : EventListener() {
          override fun canceled(call: Call) {
            canceled.set(true)
          }
        }
      }
      .build()
    val address = ServerAddress.parse(server.url("/").toString())!!
    val client = ApiClient(address, CookieStore(address.origin, Memory()), http)
    val deleteDone = AtomicBoolean(false)
    val api = object : FakeTvApi() {
      override suspend fun startGlobalSearch(body: GlobalSearchStartDto): GlobalSearchStartResultDto =
        GlobalSearchStartResultDto(
          id = "gs",
          snapshot = cz.stremiooffline.tv.data.GlobalSearchSnapshotDto(revision = 1, state = "complete"),
        )

      override suspend fun pollGlobalSearch(id: String, revision: Int): GlobalSearchPollDto =
        client.pollGlobalSearch(id, revision)

      override suspend fun pageGlobalSearch(id: String) = client.pageGlobalSearch(id)

      override suspend fun retryGlobalSearchSource(id: String, sourceId: String) =
        client.retryGlobalSearchSource(id, sourceId)

      override suspend fun globalSearchMembers(id: String, memberKey: String, from: Int): GlobalSearchMemberPageDto =
        client.globalSearchMembers(id, memberKey, from)

      override suspend fun deleteGlobalSearch(id: String) = client.deleteGlobalSearch(id).also { deleteDone.set(true) }
    }
    var shown by mutableStateOf(true)
    compose.setContent {
      if (shown) {
        GlobalSearchScreen(
          api = api,
          onOpenCatalog = {},
          onOpenRemote = {},
          onOpenLibrary = {},
          imageUrl = { null },
          overlayOpen = false,
          voiceAvailable = false,
        )
      }
    }

    compose.onNodeWithTag(TagGlobalSearchField).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.onNodeWithTag(TagGlobalSearchInput).performTextInput("matrix")
    compose.onNodeWithTag(TagGlobalSearchInput).performImeAction()
    compose.waitForIdle()

    try {
      compose.waitUntil(15_000) { paths.size >= 1 }
    } catch (timeout: androidx.compose.ui.test.ComposeTimeoutException) {
      throw AssertionError("requests: $paths", timeout)
    }
    server.takeRequest()
    compose.runOnUiThread { shown = false }
    compose.waitForIdle()
    try {
      compose.waitUntil(15_000) { canceled.get() }
    } catch (timeout: androidx.compose.ui.test.ComposeTimeoutException) {
      throw AssertionError("canceled: $canceled, deleteDone: $deleteDone", timeout)
    }
    assertTrue(canceled.get())
  }

  private class Memory : SessionPersistence {
    override fun loadSession(origin: String): String? = null
    override fun saveSession(origin: String, value: String?) = Unit
  }
}
