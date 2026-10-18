@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Leaving the player closes the media server's own session as well as the local one. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerScreenRemoteSessionTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private val api = FakeTvApi().apply {
    startAnswer = PlaybackDescriptorDto(id = "p1", url = "/stream.mp4")
  }

  private var exited = false

  private fun target(remote: RemoteItemContext?) = PlayTarget(
    key = "remote:lib1:item1",
    title = "It",
    resume = false,
    sourceId = "src1",
    remoteItem = remote,
  )

  private fun mount(remote: RemoteItemContext?) {
    compose.setContent {
      PlayerScreen(api = api, target = target(remote), onExit = { exited = true })
    }
    compose.waitForIdle()
  }

  private fun backKey() {
    compose.runOnUiThread {
      compose.activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK))
      compose.activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_BACK))
    }
    compose.waitForIdle()
  }

  private fun leavePlayer() {
    repeat(4) {
      if (!exited) backKey()
    }
    compose.waitUntil(5_000) { exited }
  }

  @Test
  fun `a remote play starts and stops the media server session`() {
    mount(RemoteItemContext("lib1", "item1", "ms1", "remote:lib1:item1"))
    compose.waitUntil(5_000) { api.remotePlaybackReports.any { it.third.event == "start" } }

    val start = api.remotePlaybackReports.single { it.third.event == "start" }
    assertEquals("lib1", start.first)
    assertEquals("item1", start.second)
    assertEquals("ms1", start.third.mediaSourceId)

    leavePlayer()
    compose.waitUntil(5_000) { api.remotePlaybackReports.any { it.third.event == "stop" } }

    val stop = api.remotePlaybackReports.single { it.third.event == "stop" }
    assertEquals("lib1", stop.first)
    assertEquals("item1", stop.second)
    assertEquals("ms1", stop.third.mediaSourceId)
  }

  @Test
  fun `a play without a remote item reports nothing`() {
    mount(remote = null)
    compose.waitUntil(5_000) { api.startedSources.isNotEmpty() }

    leavePlayer()
    compose.waitForIdle()

    assertTrue(api.remotePlaybackReports.isEmpty())
  }
}
