package cz.stremiooffline.tv.ui.home

import androidx.annotation.StringRes
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.catalog.ResumeEpisode
import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.episodeCodeText
import cz.stremiooffline.tv.data.yearText
import cz.stremiooffline.tv.playback.Progress
import cz.stremiooffline.tv.ui.catalog.CatalogDetailArgs
import cz.stremiooffline.tv.ui.detail.PlayTarget
import cz.stremiooffline.tv.ui.detail.RemoteDetailData

/** What OK on a Home card asks the shell to do. */
sealed interface HomeAction {
  data class Play(val target: PlayTarget) : HomeAction

  data class OpenLibrary(val path: String) : HomeAction

  data class OpenCatalog(val args: CatalogDetailArgs) : HomeAction

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
  is HomeCard.Completed -> R.string.player_play
  is HomeCard.Episode -> R.string.home_new_episode
  is HomeCard.ResumeCatalogue -> when {
    card.pending -> R.string.home_next_episode
    card.type == "series" -> R.string.home_open_episode
    else -> R.string.home_open_title
  }
  else -> null
}

/** The remote card as the native detail needs it: opaque identity only, never a path or a
 *  catalogue id. */
fun remoteDetailOf(card: HomeCard.Remote): RemoteDetailData = RemoteDetailData(
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
  ),
)

/** The web's `captionOf`, minus the age and release-date text the TV deliberately leaves out. */
fun captionOf(card: HomeCard, label: String?): String? = listOfNotNull(
  label,
  card.episodeCodeText,
  (card as? HomeCard.ResumeFile)?.subtitle?.takeIf { it.isNotBlank() },
  (card as? HomeCard.Remote)?.let { remote ->
    listOf(remote.provider, remote.libraryName).filter { it.isNotBlank() }.joinToString(" · ").takeIf { it.isNotBlank() }
  },
  card.yearText?.takeIf { it.isNotBlank() },
).joinToString(" · ").ifEmpty { null }

/** The catalogue title a card's hero describes itself with: the type and the id `meta` is asked
 *  for. Nothing for the kinds the library backs, which carry no catalogue metadata and ask for none. */
fun HomeCard.heroMetaRef(): Pair<String, String>? = when (this) {
  is HomeCard.ResumeCatalogue -> type to id
  is HomeCard.Episode -> type to metaId
  is HomeCard.Discovery -> type to id
  is HomeCard.FavoriteCatalogue -> type to id
  else -> null
}

/** The hero's line under the title: the catalogue's own year, genres, runtime and rating once the
 *  title has answered, the card's year and episode code while it has not (or when it has none).
 *  An episode keeps its episode code the way it always has. */
fun heroMetaLine(card: HomeCard, meta: MetaDto?): String {
  if (meta != null && card !is HomeCard.Episode) {
    val line = listOfNotNull(
      meta.yearText ?: card.yearText,
      *meta.genres.orEmpty().take(3).toTypedArray(),
      meta.runtime?.takeIf { it.isNotBlank() },
      meta.ratingText?.let { "★ $it" },
    ).joinToString(" · ")
    if (line.isNotEmpty()) return line
  }
  return listOfNotNull(card.yearText, card.episodeCodeText).joinToString(" · ")
}

/** The hero's description: the catalogue's own text, or the subtitle a library file carries.
 *  Nothing when it has neither, so a library card asks for no metadata. */
fun heroDescription(card: HomeCard, meta: MetaDto?): String? =
  if (meta != null) {
    meta.description?.takeIf { it.isNotBlank() }
  } else {
    (card as? HomeCard.ResumeFile)?.subtitle?.takeIf { it.isNotBlank() }
  }

/** Where OK on a card goes: the player, the library folder or a catalogue detail. */
fun actionFor(card: HomeCard): HomeAction = when (card) {
  is HomeCard.ResumeFile -> play(card.path, card.title)
  is HomeCard.Completed -> play(card.path, card.title)
  is HomeCard.Recent -> play(card.path, card.label)
  is HomeCard.Favorite -> if (card.itemKind == "folder") HomeAction.OpenLibrary(card.path) else play(card.path, card.label)
  is HomeCard.Tonight -> if (card.itemKind == "folder") HomeAction.OpenLibrary(card.path) else play(card.path, card.label)
  is HomeCard.ResumeCatalogue -> HomeAction.OpenCatalog(
    CatalogDetailArgs(
      meta = MetaDto(id = card.id, type = card.type, name = card.name, poster = card.poster),
      addonName = "",
      type = card.type,
      episode = card.episode?.let { episode -> card.season?.let { season -> ResumeEpisode(card.key, season, episode) } },
      forgetKeys = card.forgetKeys,
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
  is HomeCard.Remote -> HomeAction.OpenRemote(remoteDetailOf(card))
}

private fun play(path: String, title: String): HomeAction.Play =
  HomeAction.Play(PlayTarget(key = Progress.libraryKey(path), title = title, resume = true, path = path))
