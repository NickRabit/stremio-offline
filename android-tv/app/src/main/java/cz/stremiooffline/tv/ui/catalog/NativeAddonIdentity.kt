package cz.stremiooffline.tv.ui.catalog

import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteProviderIdsDto
import cz.stremiooffline.tv.data.LibraryTitleDto

/**
 * The `(type, id)` pair the addon stream endpoints take for one native item, or null when no
 * request can be derived from it.
 *
 * A movie uses its own catalogue identity. An episode uses ONLY its parent series' identity plus
 * its own `:season:episode` suffix: the episode's own ids name nothing the endpoints accept, and
 * an opaque series id, a tvdb-only identity or an unknown one is no identity at all. A series,
 * season or folder has no derivation, and a missing parent identity is never looked up here -- the
 * caller hands over whatever parent data it already holds.
 */
fun nativeAddonIdentity(item: RemoteItemDto, seriesIds: RemoteProviderIdsDto?): Pair<String, String>? = when (item.type) {
  "movie" -> catalogueIdentity("movie", item.providerIds)?.let { (id, type) -> type to id }
  "episode" -> {
    val season = item.season
    val episode = item.episode
    val parent = seriesIds?.let { catalogueIdentity("series", it) }
    if (season == null || episode == null || season < 0 || episode < 1 || parent == null) null
    else parent.second to "${parent.first}:$season:$episode"
  }
  else -> null
}

/**
 * The `(type, id)` pair the addon stream endpoints take for one library file, from the catalogue
 * title the server bound it to (`GET /api/library/title`), or null when the binding names nothing
 * an addon can be asked about.
 *
 * A movie is asked under the bound catalogue id. A series binding names the series, never an
 * episode, so it is used only when the server could also tell the clicked file's own season and
 * episode: an exact `<id>:<season>:<episode>` video id, and only then under that video id. A
 * series file whose numbers could not be derived is never asked about as if it were the series,
 * and nothing is ever guessed out of a filename.
 *
 * A catalogue id may itself contain colons (`tmdb:123`), so the video id is read as the bound id,
 * a colon, then exactly a season and an episode -- never as three colon-separated parts.
 */
fun libraryAddonIdentity(title: LibraryTitleDto?): Pair<String, String>? {
  val type = title?.type?.trim().orEmpty()
  val id = title?.id?.trim().orEmpty()
  if (type.isEmpty() || id.isEmpty()) return null
  if (type != "series") return type to id
  val (season, episode) = episodeNumbers(id, title?.videoId) ?: return null
  if (season < 0 || episode < 1) return null
  return type to "$id:$season:$episode"
}

/**
 * The season and episode one series binding's video id carries, or null when it carries neither.
 * The bound id is the prefix in full -- colons and all -- and only then exactly two numeric fields
 * follow it; anything else is no video id at all.
 */
internal fun episodeNumbers(boundId: String, videoId: String?): Pair<Int, Int>? {
  if (boundId.isEmpty()) return null
  val video = videoId?.trim().orEmpty()
  if (!video.startsWith("$boundId:")) return null
  val parts = video.removePrefix("$boundId:").split(':')
  if (parts.size != 2) return null
  val season = parts[0].toIntOrNull() ?: return null
  val episode = parts[1].toIntOrNull() ?: return null
  return season to episode
}
