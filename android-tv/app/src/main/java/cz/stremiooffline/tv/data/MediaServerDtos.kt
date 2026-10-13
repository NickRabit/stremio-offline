package cz.stremiooffline.tv.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * The read-only view of a media-server library this account may browse. Remote handles are opaque:
 * the local server mints them and nothing here may be turned into a filesystem path or a URL.
 */
@Serializable
data class RemoteLibraryDto(
  val id: String = "",
  val connectionId: String = "",
  val remoteId: String = "",
  val name: String = "",
  val type: String = "",
  /** The upstream brand behind the connection; a provider the app does not list reads as such. */
  val provider: String = "",
  val enabled: Boolean = true,
  val order: Int = 0,
  val showOnHome: Boolean = false,
  val showInContinueWatching: Boolean = false,
  /** `folders` or `titles`; absent means the effective setting the server derives from the type. */
  val browseMode: String? = null,
  /** Whether this library may show preview mosaics; absent means yes. */
  val mosaic: Boolean = true,
  /** Whether this library takes part in the viewer's Favourites; absent means yes. */
  val showInFavorites: Boolean = true,
  /** The library root's own same-origin poster, when the provider has one. Present means the tile
   *  draws it instead of asking for a child mosaic; absent falls back to the bounded preview. */
  val poster: String? = null,
  val capabilities: RemoteCapabilitiesDto = RemoteCapabilitiesDto(),
)

/** Everything the local server refuses for a remote library. Always false today: the feature is
 *  read-only until the server offers more. */
@Serializable
data class RemoteCapabilitiesDto(
  val rename: Boolean = false,
  val move: Boolean = false,
  val delete: Boolean = false,
  val identify: Boolean = false,
  val writeArtwork: Boolean = false,
  val downloadToLibrary: Boolean = false,
  val downloadToDevice: Boolean = false,
)

/**
 * One browseable item of a remote library. [id] is the provider item id and is the only identity
 * the app round-trips; [progressKey] is materialised only where the app needs a stable state key.
 */
@Serializable
data class RemoteItemDto(
  val id: String = "",
  val name: String = "",
  val type: String = "",
  val parentId: String? = null,
  val seriesId: String? = null,
  val season: Int? = null,
  val episode: Int? = null,
  val providerIds: RemoteProviderIdsDto = RemoteProviderIdsDto(),
  val durationTicks: Long? = null,
  /** Content-authorized same-origin artwork, loaded with the session cookie like any image. */
  val poster: String? = null,
  val wide: String? = null,
)

/** The external ids a provider knows for one item; any of them may be absent. */
@Serializable
data class RemoteProviderIdsDto(
  val imdb: String? = null,
  val tmdb: String? = null,
  val tvdb: String? = null,
)

/** One page of `GET /api/remote-libraries/:libraryId/items`; [cursor] is absent on the last page. */
@Serializable
data class RemoteItemsPageDto(
  val items: List<RemoteItemDto> = emptyList(),
  val total: Int = 0,
  val asOf: String? = null,
  val stale: Boolean = false,
  val cursor: String? = null,
  val capabilities: RemoteCapabilitiesDto = RemoteCapabilitiesDto(),
)

/** The `GET /api/remote-libraries` envelope; only the libraries this account may see are inside. */
@Serializable
data class RemoteLibrariesPageDto(
  val libraries: List<RemoteLibraryDto> = emptyList(),
)

/** One `GET /api/remote-libraries/:libraryId/items/:itemId` answer. */
@Serializable
data class RemoteItemDetailDto(
  val item: RemoteItemDto = RemoteItemDto(),
  val capabilities: RemoteCapabilitiesDto = RemoteCapabilitiesDto(),
)

/** The `sources` envelope of one remote item: each stream carries only opaque remote identity,
 *  the provider and library names, and never a raw URL. */
@Serializable
data class RemoteSourcesDto(
  val streams: List<StreamDto> = emptyList(),
)

/**
 * The context a native remote play carries: opaque identity plus the stable [progressKey] the
 * local server uses to store this item's position and preference. It crosses the player verbatim
 * and is never derived from a path or an addon.
 */
@Serializable
data class RemoteItemContext(
  val libraryId: String = "",
  val itemId: String = "",
  val mediaSourceId: String? = null,
  val progressKey: String = "",
)

/** One `GET`/`PATCH /api/remote-libraries/:libraryId/items/:itemId/state` answer: the local
 *  position and preference for one remote item, per account. */
@Serializable
data class RemoteItemStateDto(
  val key: String = "",
  val position: Double = 0.0,
  val duration: Double = 0.0,
  val favorite: Boolean = false,
  val watched: Boolean = false,
  val mediaSourceId: String? = null,
  val updatedAt: String? = null,
)

/**
 * The fields a `PATCH .../state` may change. A `null` means "leave as it is": the body encoder
 * drops the default, so only the fields a caller set travel and an explicit `false` still does.
 */
@Serializable
data class RemoteItemStatePatch(
  val position: Double? = null,
  val duration: Double? = null,
  val favorite: Boolean? = null,
  val watched: Boolean? = null,
  val mediaSourceId: String? = null,
)

/** The raw `GET /api/remote-libraries/personal` answer: the same card shapes Home draws, kept
 *  unparsed so one unknown kind cannot fail the whole page. */
@Serializable
data class RemotePersonalPageDto(
  val items: List<JsonObject> = emptyList(),
  val total: Int = 0,
  val partial: Boolean = false,
)

/** The `GET /api/remote-libraries/:libraryId/preview` answer: up to four same-origin authorized
 *  poster URLs for one library root or folder, never an upstream URL. Empty means no artwork. */
@Serializable
data class RemotePreviewDto(
  val posters: List<String> = emptyList(),
)

data class RemotePersonalPage(val items: List<HomeCard>, val total: Int, val partial: Boolean)

/** Decodes one personal page's cards, dropping the kinds the app does not model. */
fun remotePersonalCards(page: RemotePersonalPageDto, json: Json = HomeCardsJson): List<HomeCard> =
  page.items.mapNotNull { runCatching { json.decodeFromJsonElement(HomeCard.serializer(), it) }.getOrNull() }
