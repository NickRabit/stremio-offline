package cz.stremiooffline.tv.ui

import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.BrowseResult
import cz.stremiooffline.tv.data.ClientCapabilitiesDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.SourceDto
import cz.stremiooffline.tv.data.TvApi
import okhttp3.OkHttpClient

/** A `TvApi` that answers from memory, so a screen can be tested without a server. */
open class FakeTvApi : TvApi {
  var pages: MutableMap<String?, BrowseResult> = mutableMapOf()
  var progressValues: MutableMap<String, ProgressDto> = mutableMapOf()
  var browseCalls: MutableList<Pair<String?, Int>> = mutableListOf()
  var failBrowse = false

  override val http: OkHttpClient = OkHttpClient()

  override fun url(path: String): String = "http://server$path"

  override suspend fun browse(path: String?, limit: Int, skip: Int): BrowseResult {
    browseCalls += path to skip
    if (failBrowse) throw cz.stremiooffline.tv.data.ApiError(cz.stremiooffline.tv.data.ApiFailure.Generic)
    return pages[path] ?: BrowseResult(path.orEmpty(), emptyList(), 0, false)
  }

  override suspend fun librarySource(path: String): SourceDto = SourceDto(sourceId = "src:$path")

  override suspend fun progress(key: String): ProgressDto? = progressValues[key]

  override suspend fun startPlayback(sourceId: String, capabilities: ClientCapabilitiesDto, time: Double): PlaybackDescriptorDto =
    PlaybackDescriptorDto(id = "p1", url = "stream.mp4")

  override suspend fun seekPlayback(id: String, time: Double): PlaybackDescriptorDto =
    PlaybackDescriptorDto(id = id, url = "stream.m3u8", playlist = true, offset = time)

  override suspend fun escalatePlayback(id: String, time: Double): PlaybackDescriptorDto =
    PlaybackDescriptorDto(id = id, url = "escalated.m3u8", playlist = true, offset = time)

  override suspend fun pingPlayback(id: String) {}

  override suspend fun deletePlayback(id: String) {}

  override suspend fun saveProgress(key: String, position: Double, duration: Double, title: String, path: String?) {}
}

fun file(
  path: String,
  label: String = path.substringAfterLast('/'),
  season: Int? = null,
  episode: Int? = null,
  progress: ProgressDto? = null,
): BrowseItem.File = BrowseItem.File(
  path = path,
  label = label,
  season = season,
  episode = episode,
  progress = progress,
)

fun progress(position: Double, duration: Double): ProgressDto = ProgressDto(position, duration)
