@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import android.content.Context
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.TvPreferences
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The device's "Prefer server conversion" preference: off, the start declares the TV's decoders;
 * on, it sends no native capability lists, so the server treats the TV like a browser.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerPreferConversionTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private fun preferences(): TvPreferences =
    TvPreferences(ApplicationProvider.getApplicationContext<Context>())

  private fun mount(api: FakeTvApi) {
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(key = "movie:tt1", title = "It", resume = false, sourceId = "src1"),
        onExit = {},
      )
    }
    compose.waitForIdle()
  }

  @Test
  fun `off, the start carries the native capability lists`() {
    preferences().preferConversion = false
    val api = FakeTvApi()

    mount(api)

    val sent = api.startedCapabilities.single()
    assertTrue(sent.containers.isNotEmpty())
    assertTrue(sent.subtitles.isNotEmpty())
  }

  @Test
  fun `on, the start sends no native capability lists`() {
    preferences().preferConversion = true
    val api = FakeTvApi()

    mount(api)

    val sent = api.startedCapabilities.single()
    assertTrue(sent.containers.isEmpty())
    assertTrue(sent.audioDecode.isEmpty())
    assertTrue(sent.audioPassthrough.isEmpty())
    assertTrue(sent.subtitles.isEmpty())
    assertTrue(sent.deepColor.isEmpty())
  }
}
