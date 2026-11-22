package cz.stremiooffline.tv.ui.player

import android.content.Context
import androidx.media3.common.C
import androidx.test.core.app.ApplicationProvider
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PlayerBufferTest {

  @Test
  fun `player buffer follows the device memory class`() {
    assertEquals(32 * 1024 * 1024, playerBufferBytes(192, lowRam = false))
    assertEquals(32 * 1024 * 1024, playerBufferBytes(512, lowRam = true))
    assertEquals(64 * 1024 * 1024, playerBufferBytes(384, lowRam = false))
    assertEquals(C.LENGTH_UNSET, playerBufferBytes(385, lowRam = false))
  }

  @Test
  fun `the bounded load control still builds a player`() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val player = buildExoPlayer(context, OkHttpClient())
    assertNotNull(player)
    player.release()
  }
}
