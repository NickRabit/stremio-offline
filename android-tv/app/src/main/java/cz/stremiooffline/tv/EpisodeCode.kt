package cz.stremiooffline.tv

/** The one episode label the app draws: `S1 · E2`, or nothing when a number is missing. */
fun episodeCode(season: Int?, episode: Int?): String? =
  if (season != null && episode != null) "S$season · E$episode" else null
