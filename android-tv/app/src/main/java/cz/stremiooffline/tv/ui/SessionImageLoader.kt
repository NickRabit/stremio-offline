package cz.stremiooffline.tv.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import coil3.ImageLoader
import coil3.SingletonImageLoader
import coil3.compose.LocalPlatformContext

internal val LocalSessionImageLoader = staticCompositionLocalOf<ImageLoader?> { null }

@Composable
internal fun sessionImageLoader(): ImageLoader =
  LocalSessionImageLoader.current ?: SingletonImageLoader.get(LocalPlatformContext.current)
