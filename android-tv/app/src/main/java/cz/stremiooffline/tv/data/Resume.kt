package cz.stremiooffline.tv.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/** Which half of the one Continue watching list to ask for; `All` is both. */
enum class ResumeFilter(val wire: String) {
  All("all"),
  Library("library"),
  Catalog("catalog"),
}

/** The raw `GET /api/resume` answer: the same card shapes Home draws, kept unparsed so one
 *  unknown kind cannot fail the whole page, as the Favourites page does. */
@Serializable
data class ResumePageDto(
  val items: List<JsonObject> = emptyList(),
  val total: Int = 0,
  val pending: Boolean = false,
  val partial: Boolean = false,
)

data class ResumePage(val items: List<HomeCard>, val total: Int, val pending: Boolean)

/** Decodes one page's resume cards, dropping the kinds the app does not model. */
fun resumeCards(page: ResumePageDto, json: Json = HomeCardsJson): List<HomeCard> =
  page.items.mapNotNull { runCatching { json.decodeFromJsonElement(HomeCard.serializer(), it) }.getOrNull() }
