package cz.stremiooffline.tv.data

import cz.stremiooffline.tv.playback.PlaybackApi
import okhttp3.OkHttpClient

/** The library browse and paging one screen needs. */
interface LibraryApi {
  suspend fun browse(path: String?, limit: Int = 60, skip: Int = 0): BrowseResult
}

/** What the title detail needs to refresh a stored position. */
interface DetailApi {
  suspend fun progress(key: String): ProgressDto?
}

/** Everything a signed-in screen does: library, detail, images and playback. */
interface TvApi : LibraryApi, DetailApi, PlaybackApi {
  val http: OkHttpClient
  fun url(path: String): String
  suspend fun librarySource(path: String): SourceDto
}
