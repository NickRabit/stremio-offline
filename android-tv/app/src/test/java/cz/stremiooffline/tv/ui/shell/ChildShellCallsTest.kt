@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

import androidx.compose.ui.test.junit4.createComposeRule
import cz.stremiooffline.tv.ui.FakeTvApi
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class ChildShellCallsTest {

  @get:Rule val compose = createComposeRule()

  @Test
  fun `opening the shell as a child makes no refused catalogue download or extras call`() {
    val api = FakeTvApi()
    compose.setContent {
      Shell(
        start = Section.Home,
        api = api,
        username = "Kid",
        onSignOut = {},
        child = true,
      )
    }
    compose.waitForIdle()

    assertEquals(0, api.downloadsRequests)
    assertEquals(0, api.activeDownloadsRequests)
    assertEquals(0, api.addonsCalls)
    assertEquals(0, api.catalogsCalls)
    assertEquals(0, api.watchlistCalls)
    assertEquals(0, api.sourceProfilesCalls)
    assertEquals(0, api.metaRequests.size)
    assertEquals(0, api.titleExtrasRequests.size)
    assertEquals(0, api.personRequests.size)
    assertEquals(0, api.streamSourcesRequests.size)
    assertEquals(0, api.streamsRequests.size)
  }
}
