package cz.stremiooffline.tv.ui.player

import androidx.media3.common.PlaybackException
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Which player failures go to the server for a conversion instead of the error panel. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PlayerErrorKindTest {

  private fun error(code: Int) = PlaybackException("test", null, code)

  @Test
  fun `a damaged container is converted by the server like an undecodable codec`() {
    assertTrue(isDecoderError(error(PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED)))
    assertTrue(isDecoderError(error(PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED)))
    assertTrue(isDecoderError(error(PlaybackException.ERROR_CODE_DECODING_FAILED)))
  }

  @Test
  fun `a network failure is not`() {
    assertFalse(isDecoderError(error(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED)))
    assertFalse(isDecoderError(error(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS)))
  }
}
