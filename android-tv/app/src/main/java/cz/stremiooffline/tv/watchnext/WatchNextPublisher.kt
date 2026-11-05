package cz.stremiooffline.tv.watchnext

import android.annotation.SuppressLint
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.BaseColumns
import androidx.core.net.toUri
import androidx.tvprovider.media.tv.TvContractCompat.WatchNextPrograms
import androidx.tvprovider.media.tv.WatchNextProgram
import cz.stremiooffline.tv.data.ResumeFilter
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.diagnostics.AppLog
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.Request

object WatchNextPublisher {
  private val mutex = Mutex()

  suspend fun publish(context: Context, api: TvApi) {
    if (Build.VERSION.SDK_INT < 26) return
    mutex.withLock {
      withContext(Dispatchers.IO) {
        try {
          val entries = watchNextEntries(
            api.resume(ResumeFilter.All, 60, 0).items,
            System.currentTimeMillis(),
          )
          val artDir = File(context.filesDir, ART_DIRECTORY)
          artDir.mkdirs()
          val artFiles = entries.mapNotNull { entry ->
            entry.artPath?.let { path -> watchNextArtName(path) to path }
          }.toMap()
          for ((name, path) in artFiles) {
            val file = File(artDir, name)
            if (!file.isFile) downloadArt(api, path, file)
          }
          artDir.listFiles()
            ?.filter { it.isFile && it.name !in artFiles.keys }
            ?.forEach(File::delete)

          val resolver = context.contentResolver
          val existing = mutableListOf<ExistingProgram>()
          resolver.query(
            WatchNextPrograms.CONTENT_URI,
            arrayOf(
              BaseColumns._ID,
              WatchNextPrograms.COLUMN_INTERNAL_PROVIDER_ID,
              WatchNextPrograms.COLUMN_BROWSABLE,
            ),
            null,
            null,
            null,
          )?.use { cursor ->
            val idColumn = cursor.getColumnIndexOrThrow(BaseColumns._ID)
            val keyColumn = cursor.getColumnIndexOrThrow(WatchNextPrograms.COLUMN_INTERNAL_PROVIDER_ID)
            val browsableColumn = cursor.getColumnIndexOrThrow(WatchNextPrograms.COLUMN_BROWSABLE)
            while (cursor.moveToNext()) {
              existing += ExistingProgram(
                id = cursor.getLong(idColumn),
                key = cursor.getString(keyColumn).orEmpty(),
                browsable = cursor.getInt(browsableColumn) != 0,
              )
            }
          }

          val plan = planWatchNext(existing, entries)
          for (id in plan.delete) {
            resolver.delete(ContentUris.withAppendedId(WatchNextPrograms.CONTENT_URI, id), null, null)
          }
          for ((id, entry) in plan.update) {
            resolver.update(
              ContentUris.withAppendedId(WatchNextPrograms.CONTENT_URI, id),
              entry.contentValues(context, artDir),
              null,
              null,
            )
          }
          for (entry in plan.insert) {
            resolver.insert(WatchNextPrograms.CONTENT_URI, entry.contentValues(context, artDir))
          }
        } catch (error: Throwable) {
          if (error is CancellationException) throw error
          logFailure("publish", error)
        }
      }
    }
  }

  suspend fun clear(context: Context) {
    mutex.withLock {
      withContext(Dispatchers.IO) {
        try {
          File(context.filesDir, ART_DIRECTORY).deleteRecursively()
          if (Build.VERSION.SDK_INT >= 26) {
            context.contentResolver.delete(WatchNextPrograms.CONTENT_URI, null, null)
          }
        } catch (error: Throwable) {
          if (error is CancellationException) throw error
          logFailure("clear", error)
        }
      }
    }
  }

  private fun downloadArt(api: TvApi, path: String, target: File) {
    var temporary: File? = null
    try {
      api.http.newCall(Request.Builder().url(api.url(path)).get().build()).execute().use { response ->
        if (!response.isSuccessful) throw IOException("Art download failed")
        temporary = File.createTempFile("watchnext-", ".tmp", target.parentFile)
        response.body.byteStream().use { input ->
          temporary!!.outputStream().use(input::copyTo)
        }
        val downloaded = temporary!!
        if (!downloaded.renameTo(target)) throw IOException("Could not store art")
      }
    } catch (error: Throwable) {
      if (error is CancellationException) throw error
      logFailure("art download", error)
    } finally {
      temporary?.delete()
    }
  }

  @SuppressLint("RestrictedApi")
  private fun WatchNextEntry.contentValues(context: Context, artDir: File): ContentValues {
    val builder = WatchNextProgram.Builder()
      .setWatchNextType(WatchNextPrograms.WATCH_NEXT_TYPE_CONTINUE)
      .setInternalProviderId(key)
      .setTitle(title)
      .setLastPlaybackPositionMillis(positionMs.toInt())
      .setDurationMillis(durationMs.toInt())
      .setLastEngagementTimeUtcMillis(lastEngagementMs)
      .setIntent(
        Intent(Intent.ACTION_VIEW, watchNextLink(key).toUri())
          .setPackage(context.packageName),
      )
    if (season != null && episode != null) {
      builder.setType(WatchNextPrograms.TYPE_TV_EPISODE)
        .setSeasonNumber(season)
        .setEpisodeNumber(episode)
    } else {
      builder.setType(WatchNextPrograms.TYPE_MOVIE)
    }
    val artName = artPath?.let(::watchNextArtName)
    if (artName != null && File(artDir, artName).isFile) {
      builder.setPosterArtUri(
        Uri.Builder()
          .scheme("content")
          .authority("${context.packageName}.watchnextart")
          .appendPath(artName)
          .build(),
      )
      builder.setPosterArtAspectRatio(
        if (wideArt) WatchNextPrograms.ASPECT_RATIO_16_9
        else WatchNextPrograms.ASPECT_RATIO_2_3,
      )
    }
    return builder.build().toContentValues().apply {
      put(WatchNextPrograms.COLUMN_LAST_PLAYBACK_POSITION_MILLIS, positionMs)
      put(WatchNextPrograms.COLUMN_DURATION_MILLIS, durationMs)
    }
  }

  private fun logFailure(operation: String, error: Throwable) {
    AppLog.error("Watch Next $operation failed", mapOf("type" to error.javaClass.name))
  }

  private const val ART_DIRECTORY = "watchnext"
}
