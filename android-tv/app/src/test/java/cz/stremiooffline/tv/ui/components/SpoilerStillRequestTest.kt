package cz.stremiooffline.tv.ui.components

import android.content.Context
import android.graphics.Bitmap
import androidx.test.core.app.ApplicationProvider
import coil3.ImageLoader
import coil3.asImage
import coil3.decode.DataSource
import coil3.fetch.FetchResult
import coil3.fetch.Fetcher
import coil3.fetch.ImageFetchResult
import coil3.key.Keyer
import coil3.request.ImageRequest
import coil3.request.Options
import coil3.request.SuccessResult
import coil3.size.Precision
import coil3.size.Size
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A still turned hidden after it was shown sharp must not come back from the memory cache at its
 * full size: Android before 12 has no blur, so only the tiny size keeps it unreadable.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class SpoilerStillRequestTest {

  private data class Still(val id: String)

  private val context: Context get() = ApplicationProvider.getApplicationContext()

  private fun loader(): ImageLoader = ImageLoader.Builder(context)
    .components {
      add(Keyer<Still> { data, _ -> data.id })
      add(Fetcher.Factory<Still> { _, options, _ ->
        Fetcher {
          val (width, height) = when (val size = options.size) {
            Size.ORIGINAL -> 960 to 540
            else -> 24 to 14
          }
          ImageFetchResult(
            image = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).asImage(),
            isSampled = false,
            dataSource = DataSource.NETWORK,
          ) as FetchResult
        }
      })
    }
    .build()

  /** AsyncImagePainter turns a request with no precision of its own into an inexact one. */
  private fun asAsyncImageSendsIt(request: ImageRequest): ImageRequest =
    if (request.defined.precision == null) request.newBuilder().precision(Precision.INEXACT).build() else request

  @Test
  fun `a hidden still is not served from the full-size copy a sharp card cached`() = runBlocking {
    val loader = loader()
    val sharp = loader.execute(ImageRequest.Builder(context).data(Still("e3")).size(Size.ORIGINAL).build())
    assertEquals(960, (sharp as SuccessResult).image.width)
    val again = loader.execute(ImageRequest.Builder(context).data(Still("e3")).size(Size.ORIGINAL).build())
    assertEquals("cache primed", DataSource.MEMORY_CACHE, (again as SuccessResult).dataSource)

    val hidden = loader.execute(asAsyncImageSendsIt(spoilerStillRequest(context, Still("e3")))) as SuccessResult

    assertNotEquals(DataSource.MEMORY_CACHE, hidden.dataSource)
    assertEquals(24, hidden.image.width)
  }
}
