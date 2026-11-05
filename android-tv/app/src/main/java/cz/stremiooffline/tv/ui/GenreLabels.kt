package cz.stremiooffline.tv.ui

import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import cz.stremiooffline.tv.R

/** Catalogues name genres in English (Cinemeta, TMDB), some addons in lower case. The names below
 *  cover both vocabularies; anything else is shown as it came. Shared with the web's genres.ts. */
private val GENRES: Map<String, Int> = mapOf(
  "action" to R.string.genre_action,
  "adventure" to R.string.genre_adventure,
  "animation" to R.string.genre_animation,
  "biography" to R.string.genre_biography,
  "comedy" to R.string.genre_comedy,
  "crime" to R.string.genre_crime,
  "documentary" to R.string.genre_documentary,
  "drama" to R.string.genre_drama,
  "family" to R.string.genre_family,
  "fantasy" to R.string.genre_fantasy,
  "film noir" to R.string.genre_film_noir,
  "film-noir" to R.string.genre_film_noir,
  "history" to R.string.genre_history,
  "horror" to R.string.genre_horror,
  "music" to R.string.genre_music,
  "musical" to R.string.genre_musical,
  "mystery" to R.string.genre_mystery,
  "news" to R.string.genre_news,
  "reality" to R.string.genre_reality,
  "reality-tv" to R.string.genre_reality,
  "romance" to R.string.genre_romance,
  "sci-fi" to R.string.genre_scifi,
  "science fiction" to R.string.genre_scifi,
  "sci-fi & fantasy" to R.string.genre_scifi_fantasy,
  "action & adventure" to R.string.genre_action_adventure,
  "kids" to R.string.genre_kids,
  "soap" to R.string.genre_soap,
  "talk" to R.string.genre_talk,
  "talk-show" to R.string.genre_talk,
  "game-show" to R.string.genre_game_show,
  "sport" to R.string.genre_sport,
  "thriller" to R.string.genre_thriller,
  "tv movie" to R.string.genre_tv_movie,
  "war" to R.string.genre_war,
  "war & politics" to R.string.genre_war_politics,
  "western" to R.string.genre_western,
)

@StringRes
fun genreResource(name: String): Int? = GENRES[name.trim().lowercase()]

/** A translator for the genre names on screen, in the interface's language. */
@Composable
fun genreLabeler(): (String) -> String {
  val resources = LocalContext.current.resources
  val configuration = LocalConfiguration.current
  return remember(resources, configuration) { { name -> genreResource(name)?.let(resources::getString) ?: name } }
}
