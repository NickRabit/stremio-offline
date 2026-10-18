package cz.stremiooffline.tv.data

import kotlinx.serialization.Serializable

@Serializable
data class CatalogSearchScopeDto(
  val addonKey: String,
  val catalogType: String? = null,
  val catalogId: String? = null,
)

@Serializable
data class CatalogSearchStartDto(
  val query: String,
  val type: String? = null,
  val scope: CatalogSearchScopeDto? = null,
  val slotId: String,
  val generation: Int,
)

@Serializable
data class CatalogSearchStartResultDto(
  val id: String = "",
  val snapshot: CatalogSearchSnapshotDto = CatalogSearchSnapshotDto(),
)

@Serializable
data class CatalogSearchPollDto(
  val changed: Boolean = false,
  val revision: Int = 0,
  val snapshot: CatalogSearchSnapshotDto? = null,
)

@Serializable
data class CatalogSearchSnapshotDto(
  val revision: Int = 0,
  val state: String = "partial",
  val items: List<MetaDto> = emptyList(),
  val sources: Int = 0,
  val pending: Int = 0,
  val failed: Int = 0,
  val hasMore: Boolean = false,
)
