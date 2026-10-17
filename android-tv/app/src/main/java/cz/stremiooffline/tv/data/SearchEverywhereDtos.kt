package cz.stremiooffline.tv.data

import kotlinx.serialization.Serializable

@Serializable
data class GlobalSearchStartDto(
  val query: String,
  val kind: String,
  val sources: List<String>,
  val slotId: String,
  val generation: Int,
)

@Serializable
data class GlobalSearchStartResultDto(
  val id: String = "",
  val snapshot: GlobalSearchSnapshotDto = GlobalSearchSnapshotDto(),
)

@Serializable
data class GlobalSearchPollDto(
  val changed: Boolean = false,
  val revision: Int = 0,
  val snapshot: GlobalSearchSnapshotDto? = null,
)

@Serializable
data class GlobalSearchSnapshotDto(
  val revision: Int = 0,
  val state: String = "partial",
  val sources: List<GlobalSearchSourceDto> = emptyList(),
  val clusters: List<GlobalSearchClusterDto> = emptyList(),
  val unidentified: List<GlobalSearchClusterDto> = emptyList(),
  val aliases: List<GlobalSearchAliasDto> = emptyList(),
  val limitReached: Boolean = false,
)

@Serializable
data class GlobalSearchSourceDto(
  val id: String = "",
  val sourceClass: String = "",
  val label: String = "",
  val state: String = "",
  val loaded: Int = 0,
  val hasMore: Boolean = false,
  val continuation: String = "",
  val stale: Boolean = false,
  val retryable: Boolean = false,
  val errorCode: String? = null,
  val dropped: Int? = null,
)

@Serializable
data class GlobalSearchClusterDto(
  val key: String = "",
  val kind: String = "",
  val title: String = "",
  val originalTitle: String? = null,
  val year: Int? = null,
  val poster: String? = null,
  val background: String? = null,
  val sourceLabels: List<String> = emptyList(),
  val hasLocal: Boolean = false,
  val hasRemote: Boolean = false,
  val memberCount: Int = 0,
  val primaryMemberKey: String = "",
  val memberKeys: List<String> = emptyList(),
  val rank: Int = 0,
  val episodeCount: Int? = null,
)

@Serializable
data class GlobalSearchAliasDto(val retired: String = "", val current: String = "")

@Serializable
data class GlobalSearchStrongIdsDto(
  val imdb: String? = null,
  val tmdb: String? = null,
  val tvdb: String? = null,
)

@Serializable
data class GlobalSearchLocatorDto(
  val kind: String = "",
  val addonKey: String? = null,
  val type: String? = null,
  val id: String? = null,
  val catalogId: String? = null,
  val key: String? = null,
  val libraryId: String? = null,
  val itemKind: String? = null,
  val itemId: String? = null,
  val itemType: String? = null,
  val provider: String? = null,
)

@Serializable
data class GlobalSearchMemberDto(
  val memberKey: String = "",
  val sourceId: String = "",
  val sourceClass: String = "",
  val sourceLabel: String = "",
  val kind: String = "",
  val title: String = "",
  val year: Int? = null,
  val poster: String? = null,
  val description: String? = null,
  val parentIds: GlobalSearchStrongIdsDto? = null,
  val season: Int? = null,
  val episode: Int? = null,
  val episodeEnd: Int? = null,
  val conflict: Boolean = false,
  val locator: GlobalSearchLocatorDto = GlobalSearchLocatorDto(),
)

@Serializable
data class GlobalSearchCanonicalDto(
  val type: String = "",
  val id: String = "",
  val name: String = "",
  val poster: String? = null,
)

@Serializable
data class GlobalSearchMemberPageDto(
  val clusterKey: String = "",
  val members: List<GlobalSearchMemberDto> = emptyList(),
  val nextFrom: Int? = null,
  val truncated: Boolean = false,
  val canonical: GlobalSearchCanonicalDto? = null,
)
