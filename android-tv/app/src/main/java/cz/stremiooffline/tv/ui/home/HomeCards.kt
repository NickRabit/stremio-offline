package cz.stremiooffline.tv.ui.home

import androidx.annotation.StringRes
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.catalog.ProgressKey
import cz.stremiooffline.tv.catalog.ResumeEpisode
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteProviderIdsDto
import cz.stremiooffline.tv.data.TitleRefDto
import cz.stremiooffline.tv.data.episodeCodeText
import cz.stremiooffline.tv.data.yearText
import cz.stremiooffline.tv.playback.Progress
import cz.stremiooffline.tv.ui.catalog.CatalogDetailArgs
import cz.stremiooffline.tv.ui.catalog.RemoteItemRef
import cz.stremiooffline.tv.ui.detail.DetailData
import cz.stremiooffline.tv.ui.detail.PlayTarget
import cz.stremiooffline.tv.ui.detail.RemoteDetailData

/** What OK on a Home card asks the shell to do. */
sealed interface HomeAction {
  data class Play(val target: PlayTarget) : HomeAction

  data class OpenLibrary(val path: String) : HomeAction

  data class OpenCatalog(val args: CatalogDetailArgs) : HomeAction

  /** A local file opens the same detail the Library draws for it. */
  data class OpenDetail(val detail: DetailData) : HomeAction

  /** A remote media-server card: the shell opens its playable detail. */
  data class OpenRemote(val data: RemoteDetailData) : HomeAction
}

/** The web's row titles for the built-in rows, or nothing for a catalogue row. */
@StringRes
fun builtinRowTitle(id: String): Int? = when (id) {
  "resume" -> R.string.home_continue
  "favorites" -> R.string.home_favorites
  "tonight" -> R.string.home_tonight
  "episodes" -> R.string.home_new_episodes
  "completed" -> R.string.home_ready_to_play
  "recent" -> R.string.home_recent
  else -> null
}

/** The web's `cardLabel`: the key a card's caption leads with, or nothing. */
@StringRes
fun cardLabel(card: HomeCard): Int? = when (card) {
  is HomeCard.ResumeFile -> R.string.home_resume
  is HomeCard.Completed -> R.string.home_open_detail
  is HomeCard.Recent -> R.string.home_open_detail
  is HomeCard.Episode -> R.string.home_new_episode
  is HomeCard.ResumeCatalogue -> if (card.pending) R.string.home_next_episode else R.string.home_resume
  else -> null
}

/** The remote card as the native detail needs it. Exact ids already on the card travel as hints;
 *  the detail reads any missing parent metadata from the provider. */
fun remoteDetailOf(card: HomeCard.Remote): RemoteDetailData {
  val identity = card.identity
  val providerIds = identity?.takeIf { it.type == card.itemType }?.let(::remoteIds)
    ?: RemoteProviderIdsDto()
  val parentIds = identity?.takeIf { card.itemType == "episode" && it.type == "series" }?.let(::remoteIds)
  return RemoteDetailData(
    libraryId = card.libraryId,
    libraryName = card.libraryName,
    provider = card.provider,
    item = RemoteItemDto(
      id = card.itemId,
      name = card.title,
      type = card.itemType,
      season = card.season,
      episode = card.episode,
      poster = card.poster,
      wide = card.wide,
      providerIds = providerIds,
    ),
    seriesIds = parentIds,
    updatedAt = card.updatedAt,
  )
}

private fun remoteIds(identity: TitleRefDto): RemoteProviderIdsDto = when {
  identity.id.startsWith("tt") -> RemoteProviderIdsDto(imdb = identity.id)
  identity.id.startsWith("tmdb:") -> RemoteProviderIdsDto(tmdb = identity.id.removePrefix("tmdb:"))
  else -> RemoteProviderIdsDto()
}

/** The web's `captionOf`, minus the age and release-date text the TV deliberately leaves out.
 *  No caption names the library or the media server a row came from. */
fun captionOf(card: HomeCard, label: String?): String? = listOfNotNull(
  label,
  card.episodeCodeText,
  (card as? HomeCard.ResumeFile)?.subtitle?.takeIf { it.isNotBlank() },
  card.yearText?.takeIf { it.isNotBlank() },
).joinToString(" · ").ifEmpty { null }

/** The catalogue title a card's hero describes itself with: the type and the id `meta` is asked
 *  for. Library-backed cards answer only when they carry a catalogue identity. */
fun HomeCard.heroMetaRef(): Pair<String, String>? = when (this) {
  is HomeCard.ResumeFile -> identity?.let { it.type to it.id }
  is HomeCard.ResumeCatalogue -> type to id
  is HomeCard.Episode -> type to metaId
  is HomeCard.Discovery -> type to id
  is HomeCard.FavoriteCatalogue -> type to id
  is HomeCard.Tonight -> title?.let { it.type to it.id }
  is HomeCard.Favorite -> title?.let { it.type to it.id }
  is HomeCard.Remote -> identity?.let { it.type to it.id }
  else -> null
}

/** The hero's line under the title: the catalogue's year, the card's episode code, genres, runtime
 *  and rating once the title has answered, or the card's year and episode code while it has not. */
fun heroMetaLine(card: HomeCard, meta: MetaDto?, genre: (String) -> String = { it }): String {
  if (meta != null && card !is HomeCard.Episode) {
    val line = listOfNotNull(
      meta.yearText ?: card.yearText,
      card.episodeCodeText,
      *meta.genres.orEmpty().take(3).map(genre).toTypedArray(),
      meta.runtime?.takeIf { it.isNotBlank() },
      meta.ratingText?.let { "★ $it" },
    ).joinToString(" · ")
    if (line.isNotEmpty()) return line
  }
  return listOfNotNull(card.yearText, card.episodeCodeText).joinToString(" · ")
}

/** The hero's description: the catalogue's own text, falling back to a resume file's subtitle. */
fun heroDescription(card: HomeCard, meta: MetaDto?): String? =
  meta?.description?.takeIf { it.isNotBlank() }
    ?: (card as? HomeCard.ResumeFile)?.subtitle?.takeIf { it.isNotBlank() }

/** Where OK on a card goes, for Home and for Continue watching alike: a continue card opens the
 *  same detail as its non-resume counterpart, and the other kinds keep their existing destination. */
fun actionFor(card: HomeCard): HomeAction = when (card) {
  is HomeCard.ResumeFile -> card.identity?.takeIf { it.id.isNotBlank() }?.let { identity ->
    val movie = identity.type == "movie"
    HomeAction.OpenCatalog(
      CatalogDetailArgs(
        meta = MetaDto(
          id = identity.id,
          type = identity.type,
          name = if (movie) card.title else "",
          poster = if (movie) card.poster else null,
        ),
        addonName = "",
        type = identity.type,
        episode = if (identity.type == "series") {
          card.season?.let { season ->
            card.episode?.let { episode ->
              ResumeEpisode(
                ProgressKey.of("series", identity.id, "${identity.id}:$season:$episode"),
                season,
                episode,
                card.updatedAt,
              )
            }
          }
        } else null,
        forgetKeys = card.forgetKeys,
        preferredLocalPath = card.path,
      ),
    )
  } ?: fileDetail(card.path, card.title, card.season, card.episode, card.poster, card.wide)
  is HomeCard.Completed -> fileDetail(card.path, card.title, card.season, card.episode, card.poster, card.wide)
  is HomeCard.Recent -> fileDetail(card.path, card.label, card.season, card.episode, card.poster, card.wide)
  is HomeCard.Favorite -> when {
    card.title != null -> titleDetail(
      card.title,
      card.label,
      card.poster,
      card.path.takeIf { card.itemKind == "file" },
    )
    card.itemKind == "folder" -> HomeAction.OpenLibrary(card.path)
    else -> play(card.path, card.label)
  }
  is HomeCard.Tonight -> when {
    card.title != null -> titleDetail(
      card.title,
      card.label,
      card.poster,
      card.path.takeIf { card.itemKind == "file" },
    )
    card.itemKind == "folder" -> HomeAction.OpenLibrary(card.path)
    else -> play(card.path, card.label)
  }
  is HomeCard.ResumeCatalogue -> HomeAction.OpenCatalog(
    CatalogDetailArgs(
      meta = MetaDto(id = card.id, type = card.type, name = card.name, poster = card.poster),
      addonName = "",
      type = card.type,
      episode = card.episode?.let { episode ->
        card.season?.let { season -> ResumeEpisode(card.key, season, episode, card.updatedAt) }
      },
      forgetKeys = card.forgetKeys,
      autoPlay = false,
    ),
  )
  is HomeCard.Episode -> HomeAction.OpenCatalog(
    CatalogDetailArgs(
      meta = MetaDto(id = card.metaId, type = card.type, name = card.name, poster = card.poster),
      addonName = "",
      type = card.type,
      episode = ResumeEpisode(card.key, card.season ?: 0, card.episode ?: 0),
    ),
  )
  is HomeCard.Discovery -> HomeAction.OpenCatalog(
    CatalogDetailArgs(
      meta = MetaDto(id = card.id, type = card.type, name = card.name, poster = card.poster),
      addonName = "",
      type = card.type,
    ),
  )
  is HomeCard.FavoriteCatalogue -> HomeAction.OpenCatalog(
    CatalogDetailArgs(
      meta = MetaDto(id = card.id, type = card.type, name = card.name, poster = card.poster),
      addonName = "",
      type = card.type,
    ),
  )
  is HomeCard.Remote -> catalogueArgsOf(card)?.let(HomeAction::OpenCatalog)
    ?: HomeAction.OpenRemote(remoteDetailOf(card).copy(autoPlay = false))
}

private fun catalogueArgsOf(card: HomeCard.Remote): CatalogDetailArgs? {
  val identity = card.identity?.takeIf { it.id.isNotBlank() } ?: return null
  val type = when {
    card.itemType == "movie" && identity.type == "movie" -> identity.type
    card.itemType == "episode" && identity.type == "series" -> identity.type
    else -> return null
  }
  return CatalogDetailArgs(
    // An episode card names the episode and draws its still, never the series: the detail reads
    // both from the catalogue.
    meta = if (card.itemType == "episode") MetaDto(id = identity.id, type = type)
    else MetaDto(id = identity.id, type = type, name = card.title, poster = card.poster),
    addonName = "",
    type = type,
    episode = if (card.itemType == "episode") card.season?.let { season ->
      card.episode?.let { episode ->
        ResumeEpisode(
          ProgressKey.of("series", identity.id, "${identity.id}:$season:$episode"),
          season,
          episode,
          card.updatedAt,
        )
      }
    } else null,
    forgetKeys = card.forgetKeys,
    autoPlay = false,
    preferRemote = true,
    preferredRemote = RemoteItemRef(card.libraryId, card.itemId, card.mediaSourceId),
  )
}

private fun play(path: String, title: String): HomeAction.Play =
  HomeAction.Play(PlayTarget(key = Progress.libraryKey(path), title = title, resume = true, path = path))

private fun fileDetail(
  path: String,
  title: String,
  season: Int?,
  episode: Int?,
  poster: String?,
  wide: String?,
): HomeAction.OpenDetail = HomeAction.OpenDetail(
  DetailData.ofFile(
    BrowseItem.File(
      path = path,
      label = title,
      season = season,
      episode = episode,
      poster = poster,
      wide = wide,
    ),
  ),
)

/** The catalogue detail of the title a bound card stands for, named by the card's own label. */
private fun titleDetail(
  title: TitleRefDto,
  label: String,
  poster: String?,
  preferredLocalPath: String?,
): HomeAction.OpenCatalog =
  HomeAction.OpenCatalog(
    CatalogDetailArgs(
      meta = MetaDto(id = title.id, type = title.type, name = label, poster = poster),
      addonName = "",
      type = title.type,
      preferredLocalPath = preferredLocalPath,
    ),
  )
