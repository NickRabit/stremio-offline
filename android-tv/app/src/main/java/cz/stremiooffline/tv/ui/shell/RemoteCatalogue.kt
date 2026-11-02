package cz.stremiooffline.tv.ui.shell

import cz.stremiooffline.tv.catalog.ProgressKey
import cz.stremiooffline.tv.catalog.ResumeEpisode
import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.ui.catalog.CatalogDetailArgs
import cz.stremiooffline.tv.ui.catalog.RemoteItemRef
import cz.stremiooffline.tv.ui.catalog.RemoteBackend
import cz.stremiooffline.tv.ui.catalog.remoteEpisodeList
import cz.stremiooffline.tv.ui.catalog.remoteMetaId
import cz.stremiooffline.tv.ui.catalog.remoteResumeCards
import cz.stremiooffline.tv.ui.catalog.remoteVideoId
import cz.stremiooffline.tv.ui.detail.RemoteDetailData
import cz.stremiooffline.tv.ui.detail.RemoteMetadata
import kotlinx.serialization.json.JsonPrimitive

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

/** A media-server title with no catalogue identity, built from the server's own item and episodes. */
internal fun remoteOwnCatalogueArgs(
  data: RemoteDetailData,
  catalogueItem: RemoteItemDto,
  episodes: List<RemoteItemDto>,
  resume: List<HomeCard.Remote>,
): CatalogDetailArgs {
  val metaId = remoteMetaId(data.libraryId, catalogueItem.id)
  if (catalogueItem.type == "movie") {
    return CatalogDetailArgs(
      meta = MetaDto(
        id = metaId,
        type = "movie",
        name = catalogueItem.name,
        poster = catalogueItem.poster,
        background = catalogueItem.wide,
        description = catalogueItem.overview,
        releaseInfo = catalogueItem.year?.toString(),
        year = catalogueItem.year?.let(::JsonPrimitive),
      ),
      addonName = "",
      type = "movie",
      autoPlay = data.autoPlay,
      preferRemote = true,
      preferredRemote = RemoteItemRef(data.libraryId, catalogueItem.id),
      backend = RemoteBackend(
        libraryId = data.libraryId,
        libraryName = data.libraryName,
        provider = data.provider,
        item = catalogueItem,
      ),
    )
  }

  val opened = data.item.takeIf { it.type == "episode" && it.id.isNotBlank() }
  val allEpisodes = (episodes + listOfNotNull(opened)).distinctBy { it.id }.filter { it.id.isNotBlank() }
  val resumeCard = resume.firstOrNull { card ->
    card.libraryId == data.libraryId &&
      card.itemType == "episode" &&
      allEpisodes.any { it.id == card.itemId }
  }
  val selected = resumeCard?.let { card -> allEpisodes.firstOrNull { it.id == card.itemId } }
    ?: opened?.let { episode -> allEpisodes.firstOrNull { it.id == episode.id } }
    ?: allEpisodes.firstOrNull()
  val hero = catalogueItem.copy(
    overview = catalogueItem.overview ?: opened?.overview,
    poster = catalogueItem.poster ?: opened?.poster,
    wide = catalogueItem.wide ?: opened?.wide,
    year = catalogueItem.year ?: opened?.year,
  )
  val videos = allEpisodes.map { episode ->
    VideoDto(
      id = remoteVideoId(data.libraryId, episode.id),
      title = episode.name,
      season = episode.season,
      episode = episode.episode,
      overview = episode.overview,
      thumbnail = episode.wide ?: episode.poster,
    )
  }
  val selectedEpisode = selected?.let { episode ->
    val season = episode.season ?: return@let null
    val number = episode.episode ?: return@let null
    ResumeEpisode(
      ProgressKey.of("series", metaId, remoteVideoId(data.libraryId, episode.id)),
      season,
      number,
    )
  }
  return CatalogDetailArgs(
    meta = MetaDto(
      id = metaId,
      type = "series",
      name = hero.name,
      poster = hero.poster,
      background = hero.wide,
      description = hero.overview,
      releaseInfo = hero.year?.toString(),
      year = hero.year?.let(::JsonPrimitive),
      videos = videos,
    ),
    addonName = "",
    type = "series",
    episode = selectedEpisode,
    autoPlay = data.autoPlay,
    preferRemote = true,
    preferredRemote = selected?.let {
      RemoteItemRef(data.libraryId, it.id, resumeCard?.mediaSourceId)
    },
    backend = RemoteBackend(
      libraryId = data.libraryId,
      libraryName = data.libraryName,
      provider = data.provider,
      item = hero,
      episodes = allEpisodes,
      resume = resume,
      seriesName = hero.name,
      seriesIds = hero.providerIds,
    ),
  )
}

/** Resolves the media-server identity a no-id detail needs, or null when the old detail must stay. */
internal suspend fun remoteOwnCatalogueArgs(
  api: TvApi,
  data: RemoteDetailData,
  metadata: RemoteMetadata,
): CatalogDetailArgs? {
  val catalogueItem = when (metadata.item.type) {
    "movie", "series" -> metadata.item
    "episode", "season" -> {
      val seriesId = metadata.item.seriesId?.takeIf { it.isNotBlank() } ?: return null
      api.remoteItem(data.libraryId, seriesId).item.takeIf { it.type == "series" } ?: return null
    }
    else -> return null
  }
  val episodes = if (catalogueItem.type == "series") {
    remoteEpisodeList(api, data.libraryId, catalogueItem.id).takeIf { it.isNotEmpty() } ?: return null
  } else {
    emptyList()
  }
  val resume = if (catalogueItem.type == "series") {
    remoteResumeCards(api, data.libraryId)
  } else {
    emptyList()
  }
  return remoteOwnCatalogueArgs(data, catalogueItem, episodes, resume)
}
