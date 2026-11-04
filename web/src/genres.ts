import { t, type Key } from "./i18n";

/** Catalogues name genres in English (Cinemeta, TMDB). The names below cover both vocabularies;
 *  anything else, such as a genre a Jellyfin server already gives in Czech, is shown as it came. */
const KEYS: Record<string, Key> = {
  "action": "genre.action",
  "adventure": "genre.adventure",
  "animation": "genre.animation",
  "biography": "genre.biography",
  "comedy": "genre.comedy",
  "crime": "genre.crime",
  "documentary": "genre.documentary",
  "drama": "genre.drama",
  "family": "genre.family",
  "fantasy": "genre.fantasy",
  "film noir": "genre.filmNoir",
  "film-noir": "genre.filmNoir",
  "history": "genre.history",
  "horror": "genre.horror",
  "music": "genre.music",
  "musical": "genre.musical",
  "mystery": "genre.mystery",
  "news": "genre.news",
  "reality": "genre.reality",
  "reality-tv": "genre.reality",
  "romance": "genre.romance",
  "sci-fi": "genre.scifi",
  "science fiction": "genre.scifi",
  "sci-fi & fantasy": "genre.scifiFantasy",
  "action & adventure": "genre.actionAdventure",
  "kids": "genre.kids",
  "soap": "genre.soap",
  "talk": "genre.talk",
  "talk-show": "genre.talk",
  "game-show": "genre.gameShow",
  "sport": "genre.sport",
  "thriller": "genre.thriller",
  "tv movie": "genre.tvMovie",
  "war": "genre.war",
  "war & politics": "genre.warPolitics",
  "western": "genre.western",
};

/** A genre in the interface's language when it is one of the known catalogue names. */
export function genreLabel(name: string): string {
  const key = KEYS[name.trim().toLowerCase()];
  return key ? t(key) : name;
}
