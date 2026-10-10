@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.components

import android.content.Context
import android.graphics.drawable.ColorDrawable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.test.core.app.ApplicationProvider
import coil.ImageLoader
import coil.compose.LocalImageLoader
import coil.intercept.Interceptor
import coil.request.ErrorResult
import coil.request.ImageRequest
import coil.request.ImageResult
import coil.request.SuccessResult
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The artwork rules of a card: the field fallback, the load fallback and the gradient title. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class CardsTest {

  @get:Rule val compose = createComposeRule()

  private val context: Context get() = ApplicationProvider.getApplicationContext()

  private class RecordingInterceptor(
    private val requested: MutableList<String>,
    private val loads: (String) -> Boolean,
    private val context: Context,
  ) : Interceptor {
    override suspend fun intercept(chain: Interceptor.Chain): ImageResult {
      val data = chain.request.data.toString()
      requested += data
      return if (loads(data)) {
        SuccessResult(ColorDrawable(android.graphics.Color.RED), chain.request, isSampled = false, dataSource = coil.decode.DataSource.MEMORY)
      } else {
        ErrorResult(ColorDrawable(android.graphics.Color.GRAY), chain.request, throwable = IllegalStateException("no image"))
      }
    }
  }

  private fun loader(requested: MutableList<String>, loads: (String) -> Boolean = { true }): ImageLoader =
    ImageLoader.Builder(context)
      .components { add(RecordingInterceptor(requested, loads, context)) }
      .build()

  @Test
  fun `a wide card falls back to its poster when the still does not load`() {
    val requested = mutableListOf<String>()
    val imageLoader = loader(requested) { it != "http://server/wide.jpg" }
    compose.setContent {
      CompositionLocalProvider(LocalImageLoader provides imageLoader) {
        WideCard(
          label = "It",
          imageUrl = "http://server/wide.jpg",
          fallbackImageUrl = "http://server/poster.jpg",
          progress = null,
          completed = false,
          onClick = {},
        )
      }
    }
    compose.waitForIdle()
    compose.waitUntil("the fallback is asked for") { requested.contains("http://server/poster.jpg") }

    assertTrue(requested.contains("http://server/wide.jpg"))
  }

  @Test
  fun `a wide card only draws its title over the gradient`() {
    val requested = mutableListOf<String>()
    compose.setContent {
      CompositionLocalProvider(LocalImageLoader provides loader(requested)) {
        WideCard(label = "It", imageUrl = "http://server/wide.jpg", progress = null, completed = false, onClick = {})
      }
    }
    compose.waitForIdle()
    compose.waitUntil("the still is asked for") { requested.isNotEmpty() }

    // One caption under the card; nothing over the artwork now that a still is on it.
    compose.onAllNodesWithText("It").assertCountEquals(1)
  }

  @Test
  fun `a poster card falls back to its wide art`() {
    val requested = mutableListOf<String>()
    val imageLoader = loader(requested) { it != "http://server/poster.jpg" }
    compose.setContent {
      CompositionLocalProvider(LocalImageLoader provides imageLoader) {
        PosterCard(
          name = "It",
          imageUrl = "http://server/poster.jpg",
          fallbackImageUrl = "http://server/wide.jpg",
          progress = null,
          onClick = {},
        )
      }
    }
    compose.waitForIdle()
    compose.waitUntil("the wide fallback is asked for") { requested.contains("http://server/wide.jpg") }
  }
}
