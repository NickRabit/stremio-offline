package cz.stremiooffline.tv.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/** The stored watch position of one title, the way `GET`/`POST /api/progress` carry it. */
@Serializable
data class ProgressDto(val position: Double = 0.0, val duration: Double = 0.0)

/** One row of `GET /api/library/browse`. The server tags every item with `kind`. */
@Serializable
sealed class BrowseItem {
  abstract val path: String
  abstract val poster: String?
  abstract val wide: String?

  @Serializable
  @SerialName("library")
  data class Library(
    override val path: String,
    val libraryId: String = "",
    val name: String = "",
    val label: String = "",
    val fileCount: Int = 0,
    val titles: Int = 0,
    val size: Double = 0.0,
    val unreachable: Boolean = false,
    override val poster: String? = null,
    override val wide: String? = null,
  ) : BrowseItem()

  @Serializable
  @SerialName("folder")
  data class Folder(
    override val path: String,
    val name: String = "",
    val fileCount: Int = 0,
    val size: Double = 0.0,
    val year: String? = null,
    val description: String? = null,
    val catalogName: String? = null,
    val posters: List<String>? = null,
    override val poster: String? = null,
    override val wide: String? = null,
  ) : BrowseItem()

  @Serializable
  @SerialName("file")
  data class File(
    override val path: String,
    val label: String = "",
    val season: Int? = null,
    val episode: Int? = null,
    val size: Double = 0.0,
    val year: String? = null,
    val description: String? = null,
    val catalogName: String? = null,
    val progress: ProgressDto? = null,
    override val poster: String? = null,
    override val wide: String? = null,
  ) : BrowseItem()

  val title: String
    get() = when (this) {
      is Library -> name.ifEmpty { label }
      is Folder -> name
      is File -> label
    }
}

/** The raw `GET /api/library/browse` answer: `items` stays unparsed so one unknown kind cannot
 *  fail the whole page. */
@Serializable
data class BrowsePage(
  val path: String = "",
  val items: List<JsonObject> = emptyList(),
  val total: Int = 0,
  val pending: Boolean = false,
)

data class BrowseResult(val path: String, val items: List<BrowseItem>, val total: Int, val pending: Boolean)

/** The library JSON with `kind` as the discriminator; an item of an unknown kind decodes to null. */
val BrowseJson: Json = Json { classDiscriminator = "kind"; ignoreUnknownKeys = true }

fun browseItems(page: BrowsePage, json: Json = BrowseJson): List<BrowseItem> =
  page.items.mapNotNull { runCatching { json.decodeFromJsonElement(BrowseItem.serializer(), it) }.getOrNull() }
