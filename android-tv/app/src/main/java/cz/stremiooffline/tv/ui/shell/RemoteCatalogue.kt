package cz.stremiooffline.tv.ui.shell

import cz.stremiooffline.tv.catalog.ProgressKey
import cz.stremiooffline.tv.catalog.ResumeEpisode
import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.ui.catalog.CatalogDetailArgs
import cz.stremiooffline.tv.ui.catalog.RemoteItemRef
import cz.stremiooffline.tv.ui.detail.RemoteDetailData
import cz.stremiooffline.tv.ui.detail.RemoteMetadata

internal fun remoteCatalogueArgs(
  data: RemoteDetailData,
  metadata: RemoteMetadata,
  identity: Pair<String, String>,
  resume: List<HomeCard.Remote>,
): CatalogDetailArgs {
  val id = identity.second
  val item = metadata.item
  // A season is named and pictured by its series, never by "Season 1".
  val seriesMeta = if (item.type == "series") {
    MetaDto(id = id, type = "series", name = item.name, poster = item.poster)
  } else {
    MetaDto(id = id, type = "series", name = metadata.seriesName.orEmpty())
  }
  val resumeEpisode: ((Int, Int) -> ResumeEpisode) = { season, episode ->
    ResumeEpisode(ProgressKey.of("series", id, "$id:$season:$episode"), season, episode)
  }
  return when {
    item.type == "movie" -> CatalogDetailArgs(
      meta = MetaDto(id = id, type = "movie", name = item.name, poster = item.poster),
      addonName = "",
      type = identity.first,
      autoPlay = data.autoPlay,
      preferRemote = true,
      preferredRemote = RemoteItemRef(data.libraryId, item.id),
    )
    item.type == "episode" && item.season != null && item.episode != null -> CatalogDetailArgs(
      meta = MetaDto(id = id, type = "series"),
      addonName = "",
      type = identity.first,
      episode = resumeEpisode(item.season, item.episode),
      autoPlay = data.autoPlay,
      preferRemote = true,
      preferredRemote = RemoteItemRef(data.libraryId, item.id),
    )
    else -> {
      val card = if (item.type == "series") {
        resume.firstOrNull {
          it.libraryId == data.libraryId &&
            it.itemType == "episode" &&
            it.identity?.type == "series" &&
            it.identity.id == id &&
            it.season != null &&
            it.episode != null
        }
      } else {
        null
      }
      val cardEpisode = card?.let {
        it.season?.let { season ->
          it.episode?.let { episode -> resumeEpisode(season, episode) }
        }
      }
      CatalogDetailArgs(
        meta = seriesMeta,
        addonName = "",
        type = identity.first,
        episode = cardEpisode,
        autoPlay = data.autoPlay,
        preferRemote = true,
        // Without an episode in progress the series still plays from the server it was opened from.
        preferredRemote = card?.let { RemoteItemRef(it.libraryId, it.itemId, it.mediaSourceId) }
          ?: RemoteItemRef(data.libraryId, ""),
      )
    }
  }
}
