package cz.stremiooffline.tv.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/** Which part of the one Favourites list to ask for; `All` is every part of it. */
enum class FavoriteFilter(val wire: String) {
  All("all"),
  Library("library"),
  Catalog("catalog"),
  Remote("remote"),
}

/** One entry of `GET /api/favorites`: a library star, a catalogue star or a media-server star. */
@Serializable
sealed class FavoriteItemDto {
  /** The grid key and the identity a return restores focus by. */
  abstract val key: String

  @Serializable
  @SerialName("library")
  data class Library(
    val path: String = "",
    val label: String = "",
    val poster: String? = null,
    val wide: String? = null,
    val year: String? = null,
    val itemKind: String = "file",
    val progress: ProgressDto? = null,
    val catalogId: String? = null,
  ) : FavoriteItemDto() {
    override val key: String get() = "library:$path"
  }

  @Serializable
  @SerialName("catalog")
  data class Catalog(
    val type: String = "movie",
    val id: String = "",
    val name: String = "",
    val poster: String? = null,
    val wide: String? = null,
    val year: String? = null,
    val addonKey: String? = null,
  ) : FavoriteItemDto() {
    override val key: String get() = "catalog:$type:$id"
  }

  /** A star the account holds on a Jellyfin or Emby server: it opens that server's own detail. */
  @Serializable
  @SerialName("remote")
  data class Remote(
    val libraryId: String = "",
    val itemId: String = "",
    val title: String = "",
    val provider: String = "jellyfin",
    val libraryName: String = "",
    val itemType: String = "movie",
    val poster: String? = null,
    val wide: String? = null,
    val season: Int? = null,
    val episode: Int? = null,
  ) : FavoriteItemDto() {
    override val key: String get() = "remote:$libraryId:$itemId"
  }
}

/** The raw `GET /api/favorites` answer: `items` stays unparsed so one unknown kind cannot fail
 *  the whole page, as the library's browse page does. */
@Serializable
data class FavoritesPageDto(
  val items: List<JsonObject> = emptyList(),
  val total: Int = 0,
  val pending: Boolean = false,
  val partial: Boolean = false,
)

data class FavoritesPage(
  val items: List<FavoriteItemDto>,
  val total: Int,
  val pending: Boolean,
  /** A media server that could not be read, with the local stars kept. */
  val partial: Boolean = false,
)

/** The favourites JSON with `kind` as the discriminator; an item of an unknown kind drops. */
val FavoritesJson: Json = Json { classDiscriminator = "kind"; ignoreUnknownKeys = true }

fun favoriteItems(page: FavoritesPageDto, json: Json = FavoritesJson): List<FavoriteItemDto> =
  page.items.mapNotNull { runCatching { json.decodeFromJsonElement(FavoriteItemDto.serializer(), it) }.getOrNull() }
