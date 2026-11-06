package cz.stremiooffline.tv.playback

import cz.stremiooffline.tv.data.NextFileDto

/** The next library file the server found for the playing source, kept as `{path, title}`. */
data class NextEpisode(val path: String, val title: String)

/**
 * `GET /api/library/next/:sourceId` answers `{path, title}|null`; a source that is not a library
 * file, or one with no neighbour, has no next episode.
 */
fun nextEpisodeOf(dto: NextFileDto?): NextEpisode? =
  dto?.takeIf { it.path.isNotBlank() }?.let { NextEpisode(it.path, it.title.ifBlank { it.path.substringAfterLast('/') }) }

/**
 * The episode after a catalogue play, offered by the detail that started it. [advance] asks that
 * detail to pick the next episode's source with its own rules; the play it resolves comes back to
 * the player, and a next episode with nothing playable closes the player on that episode instead.
 */
class CatalogueNext(val title: String, val advance: () -> Unit)

/** What the player does once the picture reached its end. */
enum class EndAction { OfferNext, Wait, Leave }

/**
 * A next episode is offered. Without one the film or the last episode is over and the player
 * steps aside for the detail, unless the lookup for a next episode is still on its way.
 */
fun endAction(hasNext: Boolean, nextPending: Boolean): EndAction = when {
  hasNext -> EndAction.OfferNext
  nextPending -> EndAction.Wait
  else -> EndAction.Leave
}
