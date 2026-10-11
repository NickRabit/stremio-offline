package cz.stremiooffline.tv.playback

import cz.stremiooffline.tv.data.NextFileDto

/** The next library file the server found for the playing source, kept as `{path, title}`. */
data class NextEpisode(val path: String, val title: String)

/**
 * `GET /api/library/next/:sourceId` answers `{path, title}|null`; a source that is not a library
 * file, or one with no neighbour, has no next episode. Catalogue series are a later task, so only
 * the library answer is read here.
 */
fun nextEpisodeOf(dto: NextFileDto?): NextEpisode? =
  dto?.takeIf { it.path.isNotBlank() }?.let { NextEpisode(it.path, it.title.ifBlank { it.path.substringAfterLast('/') }) }
