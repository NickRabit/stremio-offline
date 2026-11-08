package cz.stremiooffline.tv.ui.shell

import cz.stremiooffline.tv.catalog.ProgressKey
import cz.stremiooffline.tv.catalog.ResumeEpisode
import cz.stremiooffline.tv.data.LibraryTitleDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.ui.catalog.CatalogDetailArgs
import cz.stremiooffline.tv.ui.catalog.LibraryBackend
import cz.stremiooffline.tv.ui.catalog.episodeNumbers
import cz.stremiooffline.tv.ui.detail.DetailData
import cz.stremiooffline.tv.ui.detail.episodeFiles
import cz.stremiooffline.tv.ui.detail.isCompleted
import cz.stremiooffline.tv.ui.detail.isEpisodeDetail
import cz.stremiooffline.tv.ui.detail.ownFileRows
import kotlinx.coroutines.Job
import kotlinx.serialization.json.JsonPrimitive

/**
 * The catalogue detail a bound library file or folder opens. One file is the active row; a series
 * episode opens on its season and episode, read from the server's binding before the file's own
 * numbers. A folder of several files leaves the row and the episode to the detail's own ranking.
 */
internal fun libraryCatalogueArgs(data: DetailData, binding: LibraryTitleDto): CatalogDetailArgs {
  val file = data.files.singleOrNull()
  val series = binding.type == "series"
  val numbers = if (series && file != null) {
    episodeNumbers(binding.id, binding.videoId)
      ?: file.season?.let { season -> file.episode?.let { episode -> season to episode } }
  } else null
  return CatalogDetailArgs(
    meta = MetaDto(
      id = binding.id,
      type = binding.type,
      // A series is named by the catalogue, and an episode file's picture is not the series poster.
      name = if (series) "" else binding.name ?: data.title,
      poster = data.poster.takeUnless { series && file != null },
    ),
    addonName = "",
    type = binding.type,
    episode = numbers?.let { (season, episode) ->
      ResumeEpisode(ProgressKey.of("series", binding.id, "${binding.id}:$season:$episode"), season, episode)
    },
    forgetKeys = data.forgetKeys,
    preferredLocalPath = file?.path,
  )
}

internal fun ownCatalogueArgs(data: DetailData): CatalogDetailArgs {
  val type = if (isEpisodeDetail(data)) "series" else "movie"
  val metaId = "local:${data.gridPath}"
  val episodes = if (type == "series") episodeFiles(data.files) else data.files
  val videos = if (type == "series") {
    episodes.map { file ->
      VideoDto(
        id = ownVideoId(file.path),
        season = file.season,
        episode = file.episode,
        title = file.label,
        thumbnail = file.wide ?: file.poster,
      )
    }
  } else {
    null
  }
  val playIndex = episodes.indexOfFirst { !isCompleted(it) }.let { if (it < 0) episodes.lastIndex else it }
  val playFile = episodes.getOrNull(playIndex)
  val episode = if (type == "series") {
    playFile?.season?.let { season ->
      playFile.episode?.let { number ->
        ResumeEpisode(ProgressKey.of("series", ownVideoId(playFile.path)), season, number)
      }
    }
  } else {
    null
  }
  val rows = if (type == "series") {
    episodes.associate { file -> ownVideoId(file.path) to ownFileRows(data, file) }
  } else {
    mapOf(metaId to ownFileRows(data, data.files.firstOrNull()))
  }
  return CatalogDetailArgs(
    meta = MetaDto(
      id = metaId,
      type = type,
      name = data.title,
      poster = data.poster,
      background = data.wide ?: data.poster,
      description = data.description,
      releaseInfo = data.year,
      year = data.year?.let(::JsonPrimitive),
      videos = videos,
    ),
    addonName = "",
    type = type,
    episode = episode,
    forgetKeys = data.forgetKeys,
    backend = LibraryBackend(
      rows,
      data.gridPath,
      data.favorite,
      progress = if (type == "series") {
        data.files.mapNotNull { file -> file.progress?.let { ownVideoId(file.path) to it } }.toMap()
      } else {
        emptyMap()
      },
    ),
  )
}

internal fun ownCatalogueArgsOrNull(data: DetailData): CatalogDetailArgs? =
  data.files.takeIf { it.isNotEmpty() }?.let { ownCatalogueArgs(data) }

private fun ownVideoId(path: String): String = "local:$path"

/** The binding lookup a detail is waiting for; only the newest one may open anything. */
internal class DetailLookup {
  var job: Job? = null

  fun cancel() {
    job?.cancel()
    job = null
  }

  /** Forgets [finished] when it is still the newest lookup. */
  fun done(finished: Job?) {
    if (job === finished) job = null
  }
}
