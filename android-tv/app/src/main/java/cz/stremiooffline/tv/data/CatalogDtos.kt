package cz.stremiooffline.tv.data

import cz.stremiooffline.tv.episodeCode
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** One entry of `GET /api/catalogs`: an addon's catalogue definition plus its addon. */
@Serializable
data class CatalogDto(
  val addonKey: String = "",
  val addonName: String = "",
  val type: String = "",
  val id: String = "",
  val name: String? = null,
  val extra: List<CatalogExtraDto>? = null,
) {
  /** `addonName · (name ?: id)`, the chip label the web writes. */
  val label: String get() = "$addonName · ${name ?: id}"
  val genreExtra: CatalogExtraDto? get() = extra?.firstOrNull { it.name == "genre" }
  val genreOptions: List<String> get() = genreExtra?.options.orEmpty()
}

@Serializable
data class CatalogExtraDto(
  val name: String = "",
  val isRequired: Boolean = false,
  val options: List<String>? = null,
)

/** One row of `GET /api/searchable`: a catalogue the search can be pointed at, with whether
 *  its addon is searched when nothing is picked. */
@Serializable
data class SearchableCatalogDto(
  val addonKey: String = "",
  val addonName: String = "",
  val globalSearch: Boolean = true,
  val type: String = "",
  val id: String = "",
  val name: String = "",
)

/** The catalogue item the grid draws and the detail opens. Fields the web reads loosely stay
 *  loose here too: `year` and `imdbRating` arrive as a string or a number. */
@Serializable
data class MetaDto(
  val id: String = "",
  val type: String? = null,
  val name: String = "",
  val poster: String? = null,
  val background: String? = null,
  val description: String? = null,
  val releaseInfo: String? = null,
  val nameLanguage: String? = null,
  val year: JsonElement? = null,
  val genres: List<String>? = null,
  val videos: List<VideoDto>? = null,
  val addonName: String? = null,
  val sources: List<String>? = null,
  val language: String? = null,
  val runtime: String? = null,
  val imdbRating: JsonElement? = null,
) {
  val yearText: String? get() = (releaseInfo ?: year?.text())?.take(4)?.takeIf { it.isNotEmpty() }
  val ratingText: String? get() = imdbRating?.text()?.trim()?.takeIf { Regex("^\\d+(\\.\\d+)?$").matches(it) }
}

private fun JsonElement.text(): String? = (this as? JsonPrimitive)?.contentOrNull

@Serializable
data class VideoDto(
  val id: String? = null,
  val title: String? = null,
  val name: String? = null,
  val season: Int? = null,
  val episode: Int? = null,
  val released: String? = null,
  val overview: String? = null,
  val thumbnail: String? = null,
) {
  /** The web's `episodeLabel`: the episode's own title, else its number pair. */
  val label: String
    get() = title ?: name ?: if (season != null || episode != null) {
      "${(season ?: 0).toString().padStart(2, '0')}×${(episode ?: 0).toString().padStart(2, '0')}"
    } else {
      ""
    }

  val numbered: String? get() = episodeCode(season, episode)
}

@Serializable
data class BehaviorHintsDto(
  val filename: String? = null,
  val videoSize: Double? = null,
  val bingeGroup: String? = null,
)

/** One `GET /api/streams/:type/:id` entry, the `Stream` shape the web reads. */
@Serializable
data class StreamDto(
  val sourceId: String = "",
  val kind: String = "",
  val playable: Boolean = false,
  val name: String? = null,
  val title: String? = null,
  val description: String? = null,
  val addonKey: String? = null,
  val addonName: String? = null,
  val behaviorHints: BehaviorHintsDto? = null,
  /** A copy already in one of the viewer's libraries: the wire path and the library it sits in. */
  val localPath: String? = null,
  val libraryName: String? = null,
)

/** One `GET /api/stream-sources/:type/:id` entry: a source addon the streams are asked from. */
@Serializable
data class StreamSourceDto(val key: String = "", val name: String = "")

@Serializable
data class SearchResultDto(
  val items: List<MetaDto> = emptyList(),
  val cursor: String? = null,
  val hasMore: Boolean = false,
  val sources: Int = 0,
)

/** One entry of the account's recent searches, as `GET /api/search/state` lists them. */
@Serializable
data class RecentSearchDto(val query: String = "", val usedAt: String? = null)

/** The account's search preferences and history, shared with the web. [recent] is newest first
 *  and empty while [saveHistory] is off. */
@Serializable
data class SearchStateDto(
  val saveHistory: Boolean = true,
  val liveSearch: Boolean = true,
  val defaultOrder: String = "source",
  val recent: List<RecentSearchDto> = emptyList(),
)

/** One row of `GET /api/progress`, the list resume and next-episode come from. */
@Serializable
data class ProgressEntryDto(
  val key: String = "",
  val position: Double = 0.0,
  val duration: Double = 0.0,
  val title: String = "",
  val poster: String? = null,
  val addonKey: String? = null,
  val updatedAt: String? = null,
  val series: Series? = null,
) {
  @Serializable
  data class Series(val id: String = "", val name: String = "", val season: Int = 0, val episode: Int = 0)
}

@Serializable
data class WatchlistEntryDto(
  val key: String = "",
  val type: String = "",
  val id: String = "",
  val name: String = "",
  val poster: String? = null,
  val addedAt: String? = null,
)

@Serializable
data class WatchlistToggleDto(val key: String = "", val favorite: Boolean = false)

/** One addon, for the priority `arrangeStreams` reads off the listing order and the default
 *  download library the To library panel preselects. */
@Serializable
data class AddonDto(
  val key: String = "",
  val manifest: AddonManifestDto = AddonManifestDto(),
  val downloadSettings: AddonDownloadSettingsDto? = null,
) {
  /** Where this addon saves a title of [kind] by default, or null when it names none. */
  fun defaultLibraryId(kind: String): String? =
    (if (kind == "series") downloadSettings?.series else downloadSettings?.movie)?.libraryId?.ifEmpty { null }
}

@Serializable
data class AddonManifestDto(val id: String = "", val name: String = "")

/** The per-kind save rules an addon carries in `GET /api/addons`. */
@Serializable
data class AddonDownloadSettingsDto(
  val movie: DownloadTargetSettingsDto? = null,
  val series: DownloadTargetSettingsDto? = null,
)

@Serializable
data class DownloadTargetSettingsDto(
  val libraryId: String? = null,
  val layout: String? = null,
  val subfolder: String? = null,
)

/** The `media` object `POST /api/downloads` carries, the fields `selectedMedia()` sends. */
@Serializable
data class MediaDto(
  val kind: String,
  val title: String,
  val year: Int? = null,
  val id: String? = null,
  val metaType: String? = null,
  val poster: String? = null,
  val background: String? = null,
  val season: Int? = null,
  val episode: Int? = null,
  val episodeTitle: String? = null,
)

/** What `POST /api/downloads` answers with; `status == "waiting"` is a debrid job. */
@Serializable
data class DownloadResult(val id: String = "", val status: String? = null)
