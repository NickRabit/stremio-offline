package cz.stremiooffline.tv.catalog

/** The web's progress keys for catalogue titles: `${type}:${video.id}`, or `${type}:${meta.id}`
 *  for a movie that has no video of its own. */
object ProgressKey {
  fun of(type: String?, metaId: String, videoId: String? = null): String =
    "${type ?: "movie"}:${if (videoId.isNullOrEmpty()) metaId else videoId}"
}
