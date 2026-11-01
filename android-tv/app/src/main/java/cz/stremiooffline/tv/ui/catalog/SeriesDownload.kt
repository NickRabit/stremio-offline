package cz.stremiooffline.tv.ui.catalog

import cz.stremiooffline.tv.data.BulkMediaDto
import cz.stremiooffline.tv.data.BulkPreparedEpisodeDto
import cz.stremiooffline.tv.data.VideoDto

sealed interface BulkOrigin {
  data class Catalogue(val videos: List<VideoDto>, val media: BulkMediaDto) : BulkOrigin
  data class Remote(
    val libraryId: String,
    val libraryName: String,
    val provider: String,
    val seriesItemId: String,
  ) : BulkOrigin
}

/** Which episodes a bulk download queues, in the order the panel offers them. */
enum class DownloadScope { Episode, Season, FromEpisode, All }

private fun preparedEpisodeOrder(
  left: BulkPreparedEpisodeDto,
  right: BulkPreparedEpisodeDto,
): Int =
  (left.season ?: Int.MAX_VALUE).compareTo(right.season ?: Int.MAX_VALUE)
    .takeIf { it != 0 }
    ?: (left.episode ?: Int.MAX_VALUE).compareTo(right.episode ?: Int.MAX_VALUE)

/** The prepared answer filtered client-side. Specials only join the whole series when picked. */
fun preparedScopeEpisodes(
  episodes: List<BulkPreparedEpisodeDto>,
  scope: DownloadScope,
  selected: BulkPreparedEpisodeDto? = null,
  season: Int? = selected?.season,
  includeSpecials: Boolean = false,
): List<BulkPreparedEpisodeDto> {
  val ordered = episodes.sortedWith(::preparedEpisodeOrder)
  fun numbered(episode: BulkPreparedEpisodeDto) = episode.season != null && episode.episode != null
  fun regular(episode: BulkPreparedEpisodeDto) = numbered(episode) && episode.season!! >= 1
  return when (scope) {
    DownloadScope.Episode -> ordered.filter { it.id == selected?.id }
    DownloadScope.Season -> if (season == null) emptyList() else ordered.filter { it.season == season }
    DownloadScope.FromEpisode -> {
      val selectedSeason = selected?.season
      val selectedEpisode = selected?.episode
      if (selectedSeason == null || selectedEpisode == null) {
        emptyList()
      } else {
        ordered.filter { episode ->
          regular(episode) &&
            ((episode.season ?: 0) > selectedSeason ||
              (episode.season == selectedSeason && (episode.episode ?: 0) >= selectedEpisode))
        }
      }
    }
    DownloadScope.All -> ordered.filter { episode ->
      regular(episode) || (includeSpecials && numbered(episode) && episode.season == 0)
    }
  }
}

fun preparedReadyEpisodes(episodes: List<BulkPreparedEpisodeDto>): List<BulkPreparedEpisodeDto> =
  episodes.filter { it.status == "ready" }

fun <T> batches(items: List<T>, size: Int = 500): List<List<T>> =
  if (items.isEmpty()) emptyList() else items.chunked(size.coerceAtLeast(1))
