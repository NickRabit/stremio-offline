package cz.stremiooffline.tv.catalog

import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.AddonDto
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

  /** A copy that already exists in one of the viewer's libraries. */
  fun isLocalStream(stream: StreamDto): Boolean = stream.kind == "library"

  /** The addon filter value that stands for the viewer's own library copies, the web's
   *  `LOCAL_SOURCE`: a manifest name is a plain string, so a leading control character can
   *  never collide with an addon of the same name. */
  const val LOCAL_FILTER = "\u0000local"

  /**
   * The list a source panel shows, as the web builds it. [addon] is already filtered and sorted.
   * The Local choice of the addon filter shows the library copies alone, a named addon shows its
   * streams alone, and with no addon filter the copies lead the recommended and addon-priority
   * orders but rank with the addon rows under the size sorts.
   */
  fun catalogSourceList(
    local: List<StreamDto>,
    addon: List<StreamDto>,
    filters: StreamFilters = StreamFilters(),
    preferredLanguage: String = "en",
    priority: Map<String, Int> = emptyMap(),
    titleLanguage: String? = null,
  ): List<StreamDto> = when {
    filters.addon == LOCAL_FILTER -> local
    filters.addon.isNotEmpty() -> addon
    filters.sort == StreamSort.Recommended || filters.sort == StreamSort.Addon -> local + addon
    else -> arrangeStreams(
      addon + local,
      StreamFilters(sort = filters.sort),
      preferredLanguage,
      priority,
      titleLanguage,
    )
  }

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
    upgrade: Boolean = false,
  ): Repick<T> {
    if (visible.isEmpty()) return if (selected != null && !playing) Repick(true, null) else Repick(false)
    if (playing) return Repick(false)
    if (selected == null || !visible.contains(selected)) return Repick(true, preferred)
    // A local copy may land after every addon finished, when the pending counter is already
    // zero: it replaces an automatic pick, but never the viewer's own one or a playing source.
    if (!picked && upgrade && preferred != null && selected != preferred) return Repick(true, preferred)
    // A better source may arrive while paging, but the viewer's own pick is never overridden.
    if (!picked && pending > 0 && preferred != null && selected != preferred) return Repick(true, preferred)
    return Repick(false)
  }

  fun streamBadge(stream: StreamDto): String = when {
    isLocalStream(stream) -> "LOCAL"
    stream.playable -> "HTTP"
    stream.kind == "torrent" -> "RD"
    else -> "EXT"
  }

  fun canQueue(stream: StreamDto, debridConfigured: Boolean): Boolean =
    !isLocalStream(stream) && (stream.playable || (stream.kind == "torrent" && debridConfigured))

  /** An addon that cannot be played through the server is talking to the viewer, not offering. */
  fun isAddonNotice(stream: StreamDto): Boolean = stream.kind == "unsupported"

  fun noticeText(stream: StreamDto): String =
    listOf(stream.title, stream.description, stream.name).firstOrNull { !it.isNullOrBlank() }
      ?.trim()?.replace(Regex("\\s+"), " ") ?: ""

  /**
   * The sources a viewer may play. The server hashes an identical stream to one id, so one addon
   * answering the same release twice hands two rows with one id; the panel keys its rows by that
   * id and refuses duplicates, so the second copy is dropped here.
   */
  fun offeredStreams(streams: List<StreamDto>): List<StreamDto> {
    val seen = HashSet<String>()
    return streams.filter { stream ->
      !isAddonNotice(stream) && (stream.sourceId.isBlank() || seen.add(stream.sourceId))
    }
  }

  /** One choice of a source filter: its wire value and how many of the offered streams carry it. */
  data class StreamCount(val value: String, val count: Int)

  /** The addon and language choices the filter bar offers, derived the way the web derives them:
   *  each menu is counted against what passes the other one, so two filters never contradict. */
  data class SourceFilterOptions(
    val addons: List<StreamCount>,
    val languages: List<StreamCount>,
    /** How many library copies the Local choice stands for; zero hides it unless it is chosen. */
    val localCount: Int = 0,
  )

  fun filterOptions(
    listed: List<StreamDto>,
    filters: StreamFilters,
    priority: Map<String, Int> = emptyMap(),
    titleLanguage: String? = null,
    localCount: Int = 0,
  ): SourceFilterOptions {
    val byLanguage = if (filters.language.isEmpty()) listed
    else listed.filter { streamLanguages(it, titleLanguage).contains(filters.language) }
    val byAddon = if (filters.addon.isEmpty()) listed
    else listed.filter { it.addonName == filters.addon }

    val addonCounts = LinkedHashMap<String, Int>()
    for (stream in byLanguage) {
      val name = stream.addonName ?: "?"
      addonCounts[name] = (addonCounts[name] ?: 0) + 1
    }
    // The chosen addon stays in the menu even when the language filter left it nothing, or the chip would empty.
    if (filters.addon.isNotEmpty() && filters.addon != LOCAL_FILTER && !addonCounts.containsKey(filters.addon)) addonCounts[filters.addon] = 0
    val addons = addonCounts.map { StreamCount(it.key, it.value) }
      .sortedWith(compareBy({ priority[it.value] ?: Int.MAX_VALUE }, { -it.count }))

    val languageCounts = LinkedHashMap<String, Int>()
    for (stream in byAddon) for (code in streamLanguages(stream, titleLanguage)) {
      languageCounts[code] = (languageCounts[code] ?: 0) + 1
    }
    if (filters.language.isNotEmpty() && !languageCounts.containsKey(filters.language)) languageCounts[filters.language] = 0
    val languages = languageCounts.map { StreamCount(it.key, it.value) }.sortedByDescending { it.count }

    return SourceFilterOptions(addons, languages, localCount)
  }

  /** The sources of one title after the addons that answered have been merged, sorted and
   *  filtered: the list the panel draws, the one the player holds, the addon notices, and the
   *  choices the filter bar offers. Built once per change of the raw [streams] and then
   *  remembered by the caller, so a focus move does not re-parse hundreds of sizes and languages. */
  data class SourceLists(
    val offered: List<StreamDto>,
    val visible: List<StreamDto>,
    val notices: List<StreamDto>,
    val titleLanguage: String?,
    val options: SourceFilterOptions,
    /** What the panel draws and the player holds: the library copies and the addon streams,
     *  arranged by the filters the way the web does. */
    val rows: List<StreamDto> = visible,
  )

  fun sourceLists(
    streams: List<StreamDto>,
    addons: List<AddonDto>,
    filters: StreamFilters,
    preferredLanguage: String,
    showTorrents: Boolean,
    metaLanguage: String?,
    local: List<StreamDto> = emptyList(),
  ): SourceLists {
    val offered = offeredStreams(streams)
    val priority = addons.mapIndexed { index, addon -> addon.manifest.name to index }.toMap()
    val titleLanguage = Languages.titleLanguage(metaLanguage)
    val listed = if (showTorrents) offered else offered.filter { it.kind != "torrent" }
    val visible = arrangeStreams(listed, filters, preferredLanguage, priority, titleLanguage)
    return SourceLists(
      offered = offered,
      visible = visible,
      notices = addonNotices(streams),
      titleLanguage = titleLanguage,
      options = filterOptions(listed, filters, priority, titleLanguage, local.size),
      rows = catalogSourceList(local, visible, filters, preferredLanguage, priority, titleLanguage),
    )
  }

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
