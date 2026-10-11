package cz.stremiooffline.tv.catalog

import cz.stremiooffline.tv.data.AddonSubtitleDto

/** The web's `web/src/languages.ts`, ported for the two things the catalogue needs: which
 *  languages a source is offered in, and the label to show for one. */
object Languages {

  private val FLAGS: Map<String, String> = mapOf(
    "\uD83C\uDDE8\uD83C\uDDFF" to "cs",
    "\uD83C\uDDF8\uD83C\uDDF0" to "sk",
    "\uD83C\uDDEC\uD83C\uDDE7" to "en",
    "\uD83C\uDDFA\uD83C\uDDF8" to "en",
    "\uD83C\uDDE9\uD83C\uDDEA" to "de",
    "\uD83C\uDDF5\uD83C\uDDF1" to "pl",
    "\uD83C\uDDED\uD83C\uDDFA" to "hu",
    "\uD83C\uDDEB\uD83C\uDDF7" to "fr",
    "\uD83C\uDDEA\uD83C\uDDF8" to "es",
    "\uD83C\uDDEE\uD83C\uDDF9" to "it",
    "\uD83C\uDDF7\uD83C\uDDFA" to "ru",
    "\uD83C\uDDFA\uD83C\uDDE6" to "uk",
  )

  private val WORDS: List<Pair<Regex, String>> = listOf(
    Regex("\\b(czech|cesky|česky|čeština|cestina|cz|cze|ces)\\b", RegexOption.IGNORE_CASE) to "cs",
    Regex("\\b(slovak|slovensky|slovenčina|sk|slk)\\b", RegexOption.IGNORE_CASE) to "sk",
    Regex("\\b(english|eng|en)\\b", RegexOption.IGNORE_CASE) to "en",
    Regex("\\b(german|deutsch|ger|deu)\\b", RegexOption.IGNORE_CASE) to "de",
    Regex("\\b(polish|polski|pol)\\b", RegexOption.IGNORE_CASE) to "pl",
    Regex("\\b(hungarian|magyar|hun)\\b", RegexOption.IGNORE_CASE) to "hu",
  )

  private val BINGE_CODES: Map<String, String> = mapOf(
    "cz" to "cs", "cs" to "cs", "cze" to "cs", "ces" to "cs", "czech" to "cs",
    "sk" to "sk", "slk" to "sk", "slovak" to "sk",
    "en" to "en", "eng" to "en", "english" to "en",
    "de" to "de", "ger" to "de", "deu" to "de", "german" to "de",
    "pl" to "pl", "pol" to "pl", "polish" to "pl",
    "hu" to "hu", "hun" to "hu", "hungarian" to "hu",
  )

  private val LANGUAGE_NAMES: Map<String, String> = mapOf(
    "czech" to "cs", "slovak" to "sk", "english" to "en", "german" to "de", "polish" to "pl",
    "hungarian" to "hu", "french" to "fr", "spanish" to "es", "italian" to "it", "russian" to "ru",
    "ukrainian" to "uk",
  )

  private val LANGUAGE_LABEL: Map<String, String> = mapOf(
    "cs" to "CZ", "sk" to "SK", "en" to "EN", "de" to "DE", "pl" to "PL", "hu" to "HU",
    "fr" to "FR", "es" to "ES", "it" to "IT", "ru" to "RU", "uk" to "UA", "ja" to "JP",
    "ko" to "KR", "zh" to "CN", "pt" to "PT", "nl" to "NL", "da" to "DK", "sv" to "SE",
    "no" to "NO", "fi" to "FI", "ro" to "RO", "bg" to "BG", "hr" to "HR", "sr" to "RS",
    "el" to "GR", "tr" to "TR", "ar" to "AR", "he" to "IL", "hi" to "IN",
  )

  /** A language field of the bingeGroup, e.g. `"Webshare|CZ,SK|720p|"`. Only whole fields count. */
  fun bingeGroupLanguages(bingeGroup: String?): List<String> {
    if (bingeGroup.isNullOrEmpty()) return emptyList()
    val found = LinkedHashSet<String>()
    for (token in bingeGroup.split(Regex("[|,/\\s]+"))) {
      BINGE_CODES[token.lowercase()]?.let { found.add(it) }
    }
    return found.toList()
  }

  /** The language of a title, from the English name Cinemeta sends. */
  fun titleLanguage(value: Any?): String? {
    if (value !is String) return null
    for (part in value.split(Regex("[,/]"))) {
      LANGUAGE_NAMES[part.trim().lowercase()]?.let { return it }
    }
    return null
  }

  /** An addon that left its language field blank looked and came up empty. */
  fun leavesLanguageBlank(bingeGroup: String?): Boolean =
    !bingeGroup.isNullOrEmpty() && bingeGroup.contains("|") && bingeGroup.split("|").contains("")

  fun label(code: String?): String = if (code.isNullOrEmpty()) "?" else LANGUAGE_LABEL[code] ?: code.uppercase()

  /**
   * Which addon subtitle to offer when the file left a gap, the web's `pickAddonSubtitle`.
   * Addon subtitles are the whole film, never the forced lines alone, so they belong to a viewer
   * who cannot follow the dialogue: nothing while the audio is already the language they asked
   * for, and otherwise their language, with English after it.
   */
  fun pickAddonSubtitle(
    items: List<AddonSubtitleDto>,
    preferred: String,
    spoken: String?,
    understood: String?,
  ): AddonSubtitleDto? {
    if (understood != null && spoken == understood) return null
    val wants = preferred.lowercase()
    fun speaks(item: AddonSubtitleDto, language: String) =
      item.lang.orEmpty().lowercase().startsWith(language)
    return items.firstOrNull { speaks(it, wants) } ?: items.firstOrNull { speaks(it, "en") }
  }

  /** A guess from the text the addon sent. */
  fun guessLanguages(text: String): List<String> {
    val found = LinkedHashSet<String>()
    for ((flag, code) in FLAGS) if (text.contains(flag)) found.add(code)
    for ((pattern, code) in WORDS) if (pattern.containsMatchIn(text)) found.add(code)
    return found.toList()
  }
}
