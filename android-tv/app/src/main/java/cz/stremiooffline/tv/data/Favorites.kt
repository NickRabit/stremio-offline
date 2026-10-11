package cz.stremiooffline.tv.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/** Which half of the one Favourites list to ask for; `All` is both. */
enum class FavoriteFilter(val wire: String) {
  All("all"),
  Library("library"),
  Catalog("catalog"),
}

/** One entry of `GET /api/favorites`: a library star or a catalogue star. */
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
    val year: String? = null,
    val addonKey: String? = null,
  ) : FavoriteItemDto() {
    override val key: String get() = "catalog:$type:$id"
  }
}

/** The raw `GET /api/favorites` answer: `items` stays unparsed so one unknown kind cannot fail
 *  the whole page, as the library's browse page does. */
@Serializable
data class FavoritesPageDto(
  val items: List<JsonObject> = emptyList(),
  val total: Int = 0,
  val pending: Boolean = false,
)

data class FavoritesPage(val items: List<FavoriteItemDto>, val total: Int, val pending: Boolean)

/** The favourites JSON with `kind` as the discriminator; an item of an unknown kind drops. */
val FavoritesJson: Json = Json { classDiscriminator = "kind"; ignoreUnknownKeys = true }

fun favoriteItems(page: FavoritesPageDto, json: Json = FavoritesJson): List<FavoriteItemDto> =
  page.items.mapNotNull { runCatching { json.decodeFromJsonElement(FavoriteItemDto.serializer(), it) }.getOrNull() }
