package cz.stremiooffline.tv.ui.home

import androidx.annotation.StringRes
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.catalog.ResumeEpisode
import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.episodeCodeText
import cz.stremiooffline.tv.data.yearText
import cz.stremiooffline.tv.playback.Progress
import cz.stremiooffline.tv.ui.catalog.CatalogDetailArgs
import cz.stremiooffline.tv.ui.detail.PlayTarget

/** What OK on a Home card asks the shell to do. */
sealed interface HomeAction {
  data class Play(val target: PlayTarget) : HomeAction

  data class OpenLibrary(val path: String) : HomeAction

  data class OpenCatalog(val args: CatalogDetailArgs) : HomeAction
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

/** The web's `captionOf`, minus the age and release-date text the TV deliberately leaves out. */
fun captionOf(card: HomeCard, label: String?): String? = listOfNotNull(
  label,
  card.episodeCodeText,
  (card as? HomeCard.ResumeFile)?.subtitle?.takeIf { it.isNotBlank() },
  card.yearText?.takeIf { it.isNotBlank() },
).joinToString(" · ").ifEmpty { null }

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
}

private fun play(path: String, title: String): HomeAction.Play =
  HomeAction.Play(PlayTarget(key = Progress.libraryKey(path), title = title, resume = true, path = path))
