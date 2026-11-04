package cz.stremiooffline.tv.ui

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import coil3.ImageLoader
import coil3.SingletonImageLoader
import coil3.compose.LocalPlatformContext
import coil3.disk.DiskCache
import java.security.MessageDigest
import okio.Path.Companion.toOkioPath

internal val LocalSessionImageLoader = staticCompositionLocalOf<ImageLoader?> { null }

@Composable
internal fun sessionImageLoader(): ImageLoader =
  LocalSessionImageLoader.current ?: SingletonImageLoader.get(LocalPlatformContext.current)

private const val IMAGE_CACHE_DIR = "coil3_images"
private const val IMAGE_CACHE_MAX_BYTES = 100L * 1024 * 1024

/** Folder name of one account's image cache: the server and the user, hashed. */
internal fun imageCacheKey(address: String, username: String): String =
  MessageDigest.getInstance("SHA-256")
    .digest("$address\n$username".toByteArray())
    .joinToString("") { "%02x".format(it) }
    .take(16)

/**
 * The disk cache of the signed-in account. Images are cached by URL and the server decides who may
 * see a library's artwork, so another account on the same television must not be served what this
 * one downloaded: every account has its own folder, and the folders of the others are deleted.
 */
internal fun sessionImageDiskCache(context: Context, address: String, username: String): DiskCache {
  val root = context.cacheDir.resolve(IMAGE_CACHE_DIR)
  val key = imageCacheKey(address, username)
  root.listFiles()?.filter { it.name != key }?.forEach { it.deleteRecursively() }
  return DiskCache.Builder()
    .directory(root.resolve(key).toOkioPath())
    .maxSizeBytes(IMAGE_CACHE_MAX_BYTES)
    .build()
}
