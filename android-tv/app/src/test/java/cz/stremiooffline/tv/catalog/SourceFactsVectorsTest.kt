package cz.stremiooffline.tv.catalog

import cz.stremiooffline.tv.data.BehaviorHintsDto
import cz.stremiooffline.tv.data.StreamDto
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

@RunWith(Parameterized::class)
class SourceFactsVectorsTest(private val vector: Vector) {

  @Test
  fun `matches shared source facts vector`() {
    when (vector) {
      is LanguageVector -> {
        assertEquals("${vector}: text", vector.expectedText, Streams.streamText(vector.source))
        assertEquals(
          "${vector}: guessed languages",
          vector.expectedGuessLanguages,
          Languages.guessLanguages(Streams.streamText(vector.source)),
        )
        assertEquals(
          "${vector}: binge group languages",
          vector.expectedBingeGroupLanguages,
          Languages.bingeGroupLanguages(vector.source.behaviorHints?.bingeGroup),
        )
        assertEquals(
          "${vector}: blank language field",
          vector.expectedLeavesLanguageBlank,
          Languages.leavesLanguageBlank(vector.source.behaviorHints?.bingeGroup),
        )
        assertEquals(
          "${vector}: source languages",
          vector.expectedSourceLanguages,
          Streams.streamLanguages(vector.source, vector.titleLanguage),
        )
      }

      is SizeVector -> assertEquals(
        "${vector}: size",
        vector.expected as Any?,
        Streams.streamSize(vector.source) as Any?,
      )

      is TitleLanguageVector -> assertEquals(
        "${vector}: title language",
        vector.expected,
        Languages.titleLanguage(vector.value),
      )
    }
  }

  sealed interface Vector {
    val name: String
  }

  private data class LanguageVector(
    override val name: String,
    val source: StreamDto,
    val titleLanguage: String?,
    val expectedText: String,
    val expectedGuessLanguages: List<String>,
    val expectedBingeGroupLanguages: List<String>,
    val expectedLeavesLanguageBlank: Boolean,
    val expectedSourceLanguages: List<String>,
  ) : Vector {
    override fun toString(): String = "language vector: $name"
  }

  private data class SizeVector(
    override val name: String,
    val source: StreamDto,
    val expected: Double?,
  ) : Vector {
    override fun toString(): String = "size vector: $name"
  }

  private data class TitleLanguageVector(
    override val name: String,
    val value: Any?,
    val expected: String?,
  ) : Vector {
    override fun toString(): String = "title-language vector: $name"
  }

  companion object {
    private const val VECTORS_PROPERTY = "sourceSelectionVectors"

    @JvmStatic
    @Parameterized.Parameters(name = "{index}: {0}")
    fun vectors(): List<Vector> {
      val path = System.getProperty(VECTORS_PROPERTY)
        ?: error("Gradle test property '$VECTORS_PROPERTY' is missing; run this test with Gradle")
      val file = File(path)
      check(file.isFile) { "Source-selection vectors file does not exist: $path" }

      val root = Json.parseToJsonElement(file.readText()).jsonObject
      val languageCases = root.requiredArray("languageCases").map { case ->
        val item = case.jsonObject
        val expected = item.requiredObject("expected")
        LanguageVector(
          name = item.requiredString("name"),
          source = item.requiredObject("source").toStreamDto(),
          titleLanguage = item.stringOrNull("titleLanguage"),
          expectedText = expected.requiredString("text"),
          expectedGuessLanguages = expected.requiredStrings("guessLanguages"),
          expectedBingeGroupLanguages = expected.requiredStrings("bingeGroupLanguages"),
          expectedLeavesLanguageBlank = expected.requiredBoolean("leavesLanguageBlank"),
          expectedSourceLanguages = expected.requiredStrings("sourceLanguages"),
        )
      }
      val sizeCases = root.requiredArray("sizeCases").map { case ->
        val item = case.jsonObject
        SizeVector(
          name = item.requiredString("name"),
          source = item.requiredObject("source").toStreamDto(),
          expected = item["expected"].takeUnless { it == null || it is JsonNull }?.jsonPrimitive?.doubleOrNull,
        )
      }
      val titleLanguageCases = root.requiredArray("titleLanguageCases").map { case ->
        val item = case.jsonObject
        TitleLanguageVector(
          name = item.requiredString("name"),
          value = item["value"]?.toKotlinValue(),
          expected = item["expected"].takeUnless { it == null || it is JsonNull }?.jsonPrimitive?.content,
        )
      }

      check(languageCases.isNotEmpty()) { "Source-selection vectors has no language cases" }
      check(sizeCases.isNotEmpty()) { "Source-selection vectors has no size cases" }
      check(titleLanguageCases.isNotEmpty()) { "Source-selection vectors has no title-language cases" }
      return languageCases + sizeCases + titleLanguageCases
    }
  }
}

private fun JsonObject.toStreamDto(): StreamDto {
  val hints = this["behaviorHints"]?.takeUnless { it is JsonNull }?.jsonObject?.let { hints ->
    BehaviorHintsDto(
      filename = hints.stringOrNull("filename"),
      videoSize = hints["videoSize"]?.jsonPrimitive?.doubleOrNull,
      bingeGroup = hints.stringOrNull("bingeGroup"),
    )
  }
  return StreamDto(
    name = stringOrNull("name"),
    title = stringOrNull("title"),
    description = stringOrNull("description"),
    behaviorHints = hints,
  )
}

private fun JsonObject.requiredArray(key: String): kotlinx.serialization.json.JsonArray =
  requireNotNull(this[key]) { "Missing '$key' array in source-selection vectors" }.jsonArray

private fun JsonObject.requiredObject(key: String): JsonObject =
  requireNotNull(this[key]) { "Missing '$key' object in source-selection vector" }.jsonObject

private fun JsonObject.requiredString(key: String): String =
  requireNotNull(stringOrNull(key)) { "Missing '$key' string in source-selection vector" }

private fun JsonObject.requiredBoolean(key: String): Boolean =
  this[key]?.jsonPrimitive?.booleanOrNull
    ?: error("Missing '$key' boolean in source-selection vector")

private fun JsonObject.requiredStrings(key: String): List<String> =
  requiredArray(key).map { it.jsonPrimitive.content }

private fun JsonObject.stringOrNull(key: String): String? =
  (this[key] as? JsonPrimitive)?.contentOrNull

private fun JsonElement.toKotlinValue(): Any? = when (this) {
  is JsonNull -> null
  is JsonPrimitive -> when {
    isString -> content
    booleanOrNull != null -> booleanOrNull
    doubleOrNull != null -> doubleOrNull
    else -> content
  }
  else -> error("Title-language vector value must be a JSON primitive")
}
