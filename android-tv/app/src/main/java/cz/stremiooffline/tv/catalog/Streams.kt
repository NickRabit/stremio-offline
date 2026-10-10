package cz.stremiooffline.tv.catalog

import cz.stremiooffline.tv.data.StreamDto
import kotlin.math.roundToLong

/** The web's `web/src/streams.ts`, ported without the browser-only helpers. */
object Streams {

  private val UNITS: Map<String, Double> =
    mapOf("tb" to 1e12, "gb" to 1e9, "mb" to 1e6, "kb" to 1e3, "t" to 1e12, "g" to 1e9)

  private val SIZE = Regex(
    "(\\d+(?:[.,]\\d+)?)\\s*(TB|GB|MB|KB|T|G)\\b(?!\\s*(?:/\\s*s|ps|it)\\b)",
    RegexOption.IGNORE_CASE,
  )

  /** Everything the addon wrote about the source. */
  fun streamText(stream: StreamDto): String =
    listOfNotNull(stream.name, stream.title, stream.description, stream.behaviorHints?.filename)
      .filter { it.isNotEmpty() }
      .joinToString(" ")

  fun streamSize(stream: StreamDto): Double? {
    val hinted = stream.behaviorHints?.videoSize
    if (hinted != null && hinted > 0) return hinted
    val match = SIZE.findAll(streamText(stream)).lastOrNull() ?: return null
    val value = match.groupValues[1].replace(",", ".").toDoubleOrNull() ?: return null
    val unit = UNITS[match.groupValues[2].lowercase()] ?: return null
    if (!value.isFinite() || unit <= 0) return null
    return (value * unit).roundToLong().toDouble()
  }

  /** `titleLanguage` stands in only for a source whose addon admitted it found no language. */
  fun streamLanguages(stream: StreamDto, titleLanguage: String? = null): List<String> {
    val found = (Languages.guessLanguages(streamText(stream)) +
      Languages.bingeGroupLanguages(stream.behaviorHints?.bingeGroup)).distinct()
    if (found.isNotEmpty() || titleLanguage == null || !Languages.leavesLanguageBlank(stream.behaviorHints?.bingeGroup)) return found
    return listOf(titleLanguage)
  }

  enum class StreamSort(val wire: String) {
    Recommended("recommended"),
    SizeDesc("size-desc"),
    SizeAsc("size-asc"),
    Addon("addon"),
    ;

    companion object {
      fun of(value: String?): StreamSort = entries.firstOrNull { it.wire == value } ?: Recommended
    }
  }

  data class StreamFilters(val addon: String = "", val language: String = "", val sort: StreamSort = StreamSort.Recommended)

  /** Recommended = the preferred language first, then the addon's priority, then largest first. */
  fun arrangeStreams(
    streams: List<StreamDto>,
    filters: StreamFilters,
    preferredLanguage: String,
    priority: Map<String, Int> = emptyMap(),
    titleLanguage: String? = null,
  ): List<StreamDto> {
    val list = streams.filter { stream ->
      (filters.addon.isEmpty() || stream.addonName == filters.addon) &&
        (filters.language.isEmpty() || streamLanguages(stream, titleLanguage).contains(filters.language))
    }
    val size = list.associateWith { streamSize(it) }
    val rank = { stream: StreamDto -> priority[stream.addonName ?: ""] ?: Int.MAX_VALUE }
    val preferred = { stream: StreamDto -> if (streamLanguages(stream, titleLanguage).contains(preferredLanguage)) 0 else 1 }
    val decorated = list.mapIndexed { index, stream -> stream to index }
    val sorted = decorated.sortedWith(Comparator { a, b ->
      val left = a.first
      val right = b.first
      if (filters.sort == StreamSort.Addon) return@Comparator (rank(left) - rank(right)).takeIf { it != 0 } ?: (a.second - b.second)
      if (filters.sort == StreamSort.Recommended) {
        val byLanguage = preferred(left) - preferred(right)
        if (byLanguage != 0) return@Comparator byLanguage
        val byPriority = rank(left) - rank(right)
        if (byPriority != 0) return@Comparator byPriority
      }
      val leftSize = size[left]
      val rightSize = size[right]
      if (leftSize == null || rightSize == null) {
        if (leftSize != rightSize) return@Comparator if (leftSize == null) 1 else -1
      } else if (leftSize != rightSize) {
        return@Comparator if (filters.sort == StreamSort.SizeAsc) java.lang.Double.compare(leftSize, rightSize) else java.lang.Double.compare(rightSize, leftSize)
      }
      a.second - b.second
    })
    return sorted.map { it.first }
  }

  fun visibleCatalogStreams(
    streams: List<StreamDto>,
    filters: StreamFilters,
    preferredLanguage: String,
    priority: Map<String, Int>,
    showTorrents: Boolean,
    titleLanguage: String? = null,
  ): List<StreamDto> {
    val arranged = arrangeStreams(streams, filters, preferredLanguage, priority, titleLanguage)
    return if (showTorrents) arranged else arranged.filter { it.kind != "torrent" }
  }

  fun pickDefaultStream(streams: List<StreamDto>): StreamDto? =
    streams.firstOrNull { it.playable } ?: streams.firstOrNull()

  /** What a repick decided: [move] is false when the current pick stays. */
  data class Repick<T>(val move: Boolean, val to: T? = null)

  /** Sources keep arriving after the first ones are shown, and a later one can rank higher than
   *  the one already picked. Moving is right while the viewer is still looking at the list and
   *  wrong once they are watching or picked a source themselves. */
  fun <T> repickStream(
    playing: Boolean,
    picked: Boolean,
    pending: Int,
    visible: List<T>,
    selected: T?,
    preferred: T?,
  ): Repick<T> {
    if (visible.isEmpty()) return if (selected != null && !playing) Repick(true, null) else Repick(false)
    if (playing) return Repick(false)
    if (selected == null || !visible.contains(selected)) return Repick(true, preferred)
    // A better source may arrive while paging, but the viewer's own pick is never overridden.
    if (!picked && pending > 0 && preferred != null && selected != preferred) return Repick(true, preferred)
    return Repick(false)
  }

  fun streamBadge(stream: StreamDto): String = when {
    stream.playable -> "HTTP"
    stream.kind == "torrent" -> "RD"
    else -> "EXT"
  }

  fun canQueue(stream: StreamDto, debridConfigured: Boolean): Boolean =
    stream.playable || (stream.kind == "torrent" && debridConfigured)

  /** An addon that cannot be played through the server is talking to the viewer, not offering. */
  fun isAddonNotice(stream: StreamDto): Boolean = stream.kind == "unsupported"

  fun noticeText(stream: StreamDto): String =
    listOf(stream.title, stream.description, stream.name).firstOrNull { !it.isNullOrBlank() }
      ?.trim()?.replace(Regex("\\s+"), " ") ?: ""

  fun offeredStreams(streams: List<StreamDto>): List<StreamDto> = streams.filter { !isAddonNotice(it) }

  /** One line per message; addons repeat the same notice on every request. */
  fun addonNotices(streams: List<StreamDto>): List<StreamDto> {
    val seen = LinkedHashSet<String>()
    return streams.filter { stream ->
      if (!isAddonNotice(stream)) return@filter false
      val text = noticeText(stream)
      if (text.isEmpty() || seen.contains(text)) return@filter false
      seen.add(text)
      true
    }
  }
}
