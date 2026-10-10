package cz.stremiooffline.tv.data

import cz.stremiooffline.tv.episodeCode
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/** One entry of `HomeResponse.order`: the row id and, for a catalogue row, its own title. */
@Serializable
data class HomeOrderEntry(val id: String = "", val title: String? = null) {
  val catalog: Boolean get() = id.startsWith("catalog:")
}

/** One row of `GET /api/home`. `items` stays unparsed so an unknown card kind is skipped. */
@Serializable
data class HomeRowDto(
  val status: String = "ok",
  val items: List<JsonObject> = emptyList(),
  val hasMore: Boolean = false,
  val total: Int? = null,
  val partial: Boolean = false,
)

@Serializable
data class HomeResponseDto(
  val generatedAt: String = "",
  val order: List<HomeOrderEntry> = emptyList(),
  val rows: Map<String, HomeRowDto> = emptyMap(),
)

/** The stored watch position the Home cards carry. */
@Serializable
data class HomeProgress(val position: Double = 0.0, val duration: Double = 0.0)

/**
 * One card of a Home row, the way `server/src/home.ts` shapes it. The twelve kinds the TV
 * knows; `confirm` and anything the app does not model decode to nothing and are skipped.
 */
@Serializable
sealed interface HomeCard {
  val key: String
  val poster: String?
  val wide: String?

  @Serializable
  @SerialName("resume-file")
  data class ResumeFile(
    override val key: String,
    val title: String = "",
    val subtitle: String? = null,
    override val poster: String? = null,
    override val wide: String? = null,
    val path: String = "",
    val progress: HomeProgress? = null,
    val season: Int? = null,
    val episode: Int? = null,
  ) : HomeCard

  @Serializable
  @SerialName("resume-catalogue")
  data class ResumeCatalogue(
    override val key: String,
    val title: String = "",
    override val poster: String? = null,
    override val wide: String? = null,
    val type: String = "movie",
    val id: String = "",
    val name: String = "",
    val season: Int? = null,
    val episode: Int? = null,
    val progress: HomeProgress? = null,
    val pending: Boolean = false,
  ) : HomeCard

  @Serializable
  @SerialName("completed")
  data class Completed(
    override val key: String,
    val title: String = "",
    override val poster: String? = null,
    override val wide: String? = null,
    val path: String = "",
    val season: Int? = null,
    val episode: Int? = null,
  ) : HomeCard

  @Serializable
  @SerialName("favorite")
  data class Favorite(
    override val key: String,
    val path: String = "",
    val itemKind: String = "folder",
    val label: String = "",
    override val poster: String? = null,
    override val wide: String? = null,
  ) : HomeCard

  @Serializable
  @SerialName("recent")
  data class Recent(
    override val key: String,
    val path: String = "",
    val label: String = "",
    override val poster: String? = null,
    override val wide: String? = null,
    val season: Int? = null,
    val episode: Int? = null,
  ) : HomeCard

  @Serializable
  @SerialName("episode")
  data class Episode(
    override val key: String,
    val type: String = "series",
    val metaId: String = "",
    val name: String = "",
    override val poster: String? = null,
    override val wide: String? = null,
    val season: Int? = null,
    val episode: Int? = null,
    val title: String? = null,
  ) : HomeCard

  @Serializable
  @SerialName("discovery")
  data class Discovery(
    override val key: String,
    val type: String = "movie",
    val id: String = "",
    val name: String = "",
    val title: String = "",
    override val poster: String? = null,
    override val wide: String? = null,
    val year: String? = null,
  ) : HomeCard

  @Serializable
  @SerialName("tonight")
  data class Tonight(
    override val key: String,
    val path: String = "",
    val itemKind: String = "folder",
    val label: String = "",
    val year: String? = null,
    override val poster: String? = null,
    override val wide: String? = null,
  ) : HomeCard
}

/** True for the cards the server draws wide; the rest are posters. */
val HomeCard.isWideKind: Boolean
  get() = this is HomeCard.ResumeFile || this is HomeCard.ResumeCatalogue || this is HomeCard.Episode

/** The card's display title, exactly as the web's `titleOf` picks it. */
val HomeCard.displayTitle: String
  get() = when (this) {
    is HomeCard.Favorite -> label
    is HomeCard.Recent -> label
    is HomeCard.Tonight -> label
    is HomeCard.Episode -> name
    is HomeCard.Discovery -> name
    is HomeCard.ResumeFile -> title
    is HomeCard.ResumeCatalogue -> title
    is HomeCard.Completed -> title
  }

/** The season/episode pair a card carries, when it carries one. */
val HomeCard.seasonEpisode: Pair<Int?, Int?>
  get() = when (this) {
    is HomeCard.ResumeFile -> season to episode
    is HomeCard.ResumeCatalogue -> season to episode
    is HomeCard.Completed -> season to episode
    is HomeCard.Recent -> season to episode
    is HomeCard.Episode -> season to episode
    else -> null to null
  }

/** The card's episode label, or nothing when it has no pair of numbers. */
val HomeCard.episodeCodeText: String?
  get() = seasonEpisode.let { (season, episode) -> episodeCode(season, episode) }

/** The year a card carries, for the discovery and tonight kinds. */
val HomeCard.yearText: String?
  get() = when (this) {
    is HomeCard.Discovery -> year
    is HomeCard.Tonight -> year
    else -> null
  }

/** The image a poster-shaped tile draws: its poster, else its wide art. */
val HomeCard.posterImage: String? get() = poster ?: wide

/** The image a wide tile or the backdrop draws: its wide art, else its poster. */
val HomeCard.wideImage: String? get() = wide ?: poster

/** The library path a card points at, when it has one. */
val HomeCard.libraryPath: String?
  get() = when (this) {
    is HomeCard.ResumeFile -> path
    is HomeCard.Completed -> path
    is HomeCard.Favorite -> path
    is HomeCard.Recent -> path
    is HomeCard.Tonight -> path
    else -> null
  }

/** The card's stored progress, or nothing for a pending next episode. */
val HomeCard.progressFraction: Float?
  get() {
    val progress = when (this) {
      is HomeCard.ResumeFile -> progress
      is HomeCard.ResumeCatalogue -> if (pending) null else progress
      else -> null
    } ?: return null
    if (progress.duration <= 0) return 0f
    return (progress.position / progress.duration).toFloat().coerceIn(0f, 1f)
  }

/** The Home JSON with `kind` as the discriminator; a card of an unknown kind decodes to null. */
val HomeCardsJson: Json = Json { classDiscriminator = "kind"; ignoreUnknownKeys = true }

/** Decodes one row's cards, dropping the unknown kinds rather than failing the row. */
fun homeCards(row: HomeRowDto, json: Json = HomeCardsJson): List<HomeCard> =
  row.items.mapNotNull { runCatching { json.decodeFromJsonElement(HomeCard.serializer(), it) }.getOrNull() }

enum class HomeRowStatus { Ok, Error }

/** One decoded Home row: its status, the cards that survived decoding and its flags. */
data class HomeRow(
  val status: HomeRowStatus,
  val items: List<HomeCard>,
  val hasMore: Boolean,
  val partial: Boolean,
)

fun decodeHomeRow(row: HomeRowDto, json: Json = HomeCardsJson): HomeRow = HomeRow(
  status = if (row.status == "error") HomeRowStatus.Error else HomeRowStatus.Ok,
  items = homeCards(row, json),
  hasMore = row.hasMore,
  partial = row.partial,
)
