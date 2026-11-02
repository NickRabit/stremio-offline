package cz.stremiooffline.tv.ui.shell

import cz.stremiooffline.tv.catalog.ProgressKey
import cz.stremiooffline.tv.catalog.ResumeEpisode
import cz.stremiooffline.tv.data.LibraryTitleDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.ui.catalog.CatalogDetailArgs
import cz.stremiooffline.tv.ui.catalog.episodeNumbers
import cz.stremiooffline.tv.ui.detail.DetailData

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
