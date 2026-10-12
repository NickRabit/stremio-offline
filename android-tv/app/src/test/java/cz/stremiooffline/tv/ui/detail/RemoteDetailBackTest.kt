@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.detail

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.TagSourcesPanel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The remote item detail owns Back: it is the only way out of an overlay whose rail is hidden,
 *  and the versions panel it opens still closes first. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class RemoteDetailBackTest {

  @get:Rule val compose = createEmptyComposeRule()

  private lateinit var scenario: ActivityScenario<ComponentActivity>
  private var host: ComponentActivity? = null

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

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  @Test
  fun `Back closes a remote item detail that has nothing to play`() {
    val api = FakeTvApi()
    var backs = 0
    scenario.onActivity { activity ->
      host = activity
      activity.setContent {
        RemoteDetailScreen(api = api, data = data(), onPlay = {}, onBack = { backs++ })
      }
    }
    compose.waitForIdle()

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()

    assertEquals(1, backs)
  }

  @Test
  fun `Back closes the versions panel before it closes the detail`() {
    val api = FakeTvApi()
    api.remoteSourcesValue = listOf(version("ms1"), version("ms2"))
    var backs = 0
    scenario.onActivity { activity ->
      host = activity
      activity.setContent {
        RemoteDetailScreen(api = api, data = data(), onPlay = {}, onBack = { backs++ })
      }
    }
    compose.waitForIdle()

    // Play holds the focus, then Versions: OK opens the panel on the default row.
    compose.onNodeWithTag(TagRemoteDetailPlay).assertIsFocused()
    press(Key.DirectionRight)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSourcesPanel).assertExists()

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()

    compose.onNodeWithTag(TagSourcesPanel).assertDoesNotExist()
    assertEquals(0, backs)

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()

    assertEquals(1, backs)
  }
}
