package cz.stremiooffline.tv.catalog

import cz.stremiooffline.tv.data.RemoteItemContext
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
    // A media-server version names its own tracks; that wins over a guess from its name.
    if (stream.audioLanguages.isNotEmpty()) return stream.audioLanguages.distinct()
    val found = (Languages.guessLanguages(streamText(stream)) +
      Languages.bingeGroupLanguages(stream.behaviorHints?.bingeGroup)).distinct()
    if (found.isNotEmpty() || titleLanguage == null || !Languages.leavesLanguageBlank(stream.behaviorHints?.bingeGroup)) return found
    return listOf(titleLanguage)
  }

  /**
   * A rule profile (`rule:<id>`), one of the three fixed orders, or [FirstRule] for the wire value
   * `recommended`. [FirstRule] is the first profile once that list is known; until then, and when
   * the account has no profile, sorting keeps the old language-then-priority-then-size formula.
   */
  sealed interface StreamSort {
    val wire: String
    val isRuleSort: Boolean get() = false

    data class Rule(val profileId: String) : StreamSort {
      override val wire: String get() = "$RULE_PREFIX$profileId"
      override val isRuleSort: Boolean get() = true
    }

    /** An older server's `recommended`: the first rule option, resolved when the profiles arrive. */
    data object FirstRule : StreamSort {
      override val wire: String = "recommended"
      override val isRuleSort: Boolean get() = true
    }

    data object SizeDesc : StreamSort {
      override val wire: String = "size-desc"
    }

    data object SizeAsc : StreamSort {
      override val wire: String = "size-asc"
    }

    data object Addon : StreamSort {
      override val wire: String = "addon"
    }

    companion object {
      fun of(value: String?): StreamSort {
        if (value != null && value.startsWith(RULE_PREFIX)) {
          val id = value.removePrefix(RULE_PREFIX)
          if (id.isNotEmpty()) return Rule(id)
        }
        return when (value) {
          "size-desc" -> SizeDesc
          "size-asc" -> SizeAsc
          "addon" -> Addon
          else -> FirstRule
        }
      }
    }
  }

  private const val RULE_PREFIX = "rule:"

  data class StreamFilters(val addon: String = "", val language: String = "", val sort: StreamSort = StreamSort.FirstRule)

  /** [FirstRule] becomes the first profile id. It stays unresolved when [profileIds] is empty. */
  fun resolveRuleSort(sort: StreamSort, profileIds: List<String>): StreamSort {
    if (sort !is StreamSort.FirstRule) return sort
    val id = profileIds.firstOrNull { it.isNotBlank() } ?: return sort
    return StreamSort.Rule(id)
  }

  /** The profile a rule sort orders and plays by. A size sort, an addon sort and an unresolved
   *  [StreamSort.FirstRule] have none. */
  fun ruleIdOf(sort: StreamSort): String? = (sort as? StreamSort.Rule)?.profileId

  /**
   * Which profile's verdict the row note reads. A rule sort uses that profile. A size or addon
   * sort uses the account default when that default is itself a rule, and otherwise no profile.
   */
  fun noteProfileId(active: StreamSort, accountSort: String?, profileIds: List<String>): String? {
    val account = resolveRuleSort(StreamSort.of(accountSort), profileIds)
    return when (val resolved = resolveRuleSort(active, profileIds)) {
      is StreamSort.Rule -> resolved.profileId
      StreamSort.SizeDesc, StreamSort.SizeAsc, StreamSort.Addon -> (account as? StreamSort.Rule)?.profileId
      StreamSort.FirstRule -> null
    }
  }

  /** Lexicographic over `rules[profileId].rank`, ascending better. A stream with no verdict for
   *  [profileId] sorts after every stream that has one; a tie keeps the incoming order. */
  fun compareRuleRank(a: StreamDto, b: StreamDto, profileId: String): Int {
    val left = a.rules[profileId]
    val right = b.rules[profileId]
    if (left == null && right == null) return 0
    if (left == null) return 1
    if (right == null) return -1
    val leftRank = left.rank
    val rightRank = right.rank
    val limit = minOf(leftRank.size, rightRank.size)
    for (i in 0 until limit) {
      val cmp = java.lang.Double.compare(leftRank[i], rightRank[i])
      if (cmp != 0) return cmp
    }
    return leftRank.size.compareTo(rightRank.size)
  }

  /** A rule sort uses that profile's rank when any stream carries a verdict for it. Otherwise, and
   *  for an unresolved [StreamSort.FirstRule], the preferred language comes first, then the addon's
   *  priority, then largest first. Size and addon sorts ignore rules. */
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
    val profileId = (filters.sort as? StreamSort.Rule)?.profileId
    if (profileId != null && list.any { it.rules[profileId] != null }) {
      val decorated = list.mapIndexed { index, stream -> stream to index }
      return decorated.sortedWith { a, b ->
        compareRuleRank(a.first, b.first, profileId).takeIf { it != 0 } ?: (a.second - b.second)
      }.map { it.first }
    }
    val size = list.associateWith { streamSize(it) }
    val rank = { stream: StreamDto -> priority[stream.addonName ?: ""] ?: Int.MAX_VALUE }
    val preferred = { stream: StreamDto -> if (streamLanguages(stream, titleLanguage).contains(preferredLanguage)) 0 else 1 }
    val decorated = list.mapIndexed { index, stream -> stream to index }
    val sorted = decorated.sortedWith(Comparator { a, b ->
      val left = a.first
      val right = b.first
      if (filters.sort == StreamSort.Addon) return@Comparator (rank(left) - rank(right)).takeIf { it != 0 } ?: (a.second - b.second)
      if (filters.sort.isRuleSort) {
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

  /** The row Play starts when the viewer has not picked one.
   *
   *  The last-played handle wins, including when that row breaks [ruleId]. Otherwise, once a
   *  playable row carries a verdict for [ruleId], the first playable row that meets the rule, then
   *  the first playable unverified row. Every playable row breaking the rule is no automatic
   *  choice. Without a verdict the first playable row wins, then the first row at all.
   */
  fun pickDefaultStream(
    streams: List<StreamDto>,
    preferredStableKey: String? = null,
    ruleId: String? = null,
  ): StreamDto? {
    preferredStableKey?.takeIf { it.isNotBlank() }?.let { key ->
      streams.firstOrNull { it.stableKey == key }
    }?.let { return it }
    val playable = streams.filter { it.playable }
    if (ruleId.isNullOrEmpty() || playable.none { it.rules[ruleId] != null }) {
      return playable.firstOrNull() ?: streams.firstOrNull()
    }
    return playable.firstOrNull { it.rules[ruleId]?.status == "meets" }
      ?: playable.firstOrNull { it.rules[ruleId]?.status == "unverified" }
  }

  /** The row Play acts on. An explicit pick wins. A remembered automatic row that breaks [ruleId]
   *  yields to [preferred], which is null when the rule leaves no row to start. */
  fun selectedPlayRow(
    explicit: StreamDto?,
    remembered: StreamDto?,
    preferred: StreamDto?,
    ruleId: String?,
  ): StreamDto? {
    if (explicit != null) return explicit
    if (
      !ruleId.isNullOrEmpty() &&
      remembered != null &&
      remembered != preferred &&
      remembered.rules[ruleId]?.status == "breaks"
    ) {
      return preferred
    }
    return remembered ?: preferred
  }

  /** Play opens the sources panel: [ruleId] has a verdict on a playable row and [active] is not a
   *  row it may start. */
  fun needsSourceChoice(rows: List<StreamDto>, ruleId: String?, active: StreamDto?): Boolean {
    if (active != null || ruleId.isNullOrEmpty()) return false
    return rows.any { it.playable && it.rules[ruleId] != null }
  }

  /** A copy that already exists in one of the viewer's libraries. */
  fun isLocalStream(stream: StreamDto): Boolean = stream.kind == "library"

  /** A version offered by a media server the app browses read-only. Only its opaque identity
   *  marks it: an ordinary addon stream is transport kind "remote" too, so `kind` cannot tell
   *  them apart. No file-path, download or scanner action may be taken on it. */
  fun isRemoteStream(stream: StreamDto): Boolean = stream.remoteItem != null

  /** The addon filter value that stands for the viewer's own library copies, the web's
   *  `LOCAL_SOURCE`: a manifest name is a plain string, so a leading control character can
   *  never collide with an addon of the same name. */
  const val LOCAL_FILTER = "\u0000local"

  /** The addon-filter value that narrows to one remote library, built the same collision-safe
   *  way: a leading control character, then `remote:` and the library id. */
  const val REMOTE_FILTER_PREFIX = "\u0000remote:"

  fun remoteFilter(libraryId: String): String = REMOTE_FILTER_PREFIX + libraryId

  /** The library id a remote filter value names, or null for any other value. */
  fun remoteFilterLibrary(value: String): String? =
    value.takeIf { it.startsWith(REMOTE_FILTER_PREFIX) }?.removePrefix(REMOTE_FILTER_PREFIX)

  /** One remote library's matched versions: its label and the streams the server matched. */
  data class RemoteGroup(
    val libraryId: String,
    val provider: String,
    val libraryName: String,
    val streams: List<StreamDto> = emptyList(),
  ) {
    /** The filter bar's name for this group, `provider · library`. */
    val label: String get() = listOf(provider, libraryName).filter { it.isNotBlank() }.joinToString(" · ")
  }

  /** The versions of one remote item: only streams with the same library id and item id. */
  fun remoteVersionsOf(item: RemoteItemContext?, streams: List<StreamDto>): List<StreamDto> =
    if (item == null) emptyList()
    else streams.filter {
      it.remoteItem?.libraryId == item.libraryId && it.remoteItem?.itemId == item.itemId
    }

  /**
   * What identifies one row across the groups a panel merges, as the web's `sourceIdentity` does:
   * a media-server version names itself with its whole library/item/media-source tuple, a file on
   * disk with its own path, and an addon row with its source id. Each kind is prefixed, so two
   * kinds that happen to carry the same text stay two rows, and two libraries offering the same
   * version id stay two versions.
   *
   * A row that carries none of the three has no identity at all and answers the empty string: its
   * caller draws it positionally, because nothing about it is stable across a reload.
   */
  fun rowIdentity(stream: StreamDto): String {
    val remote = stream.remoteItem
    if (remote != null) {
      val mediaSource = remote.mediaSourceId?.takeIf { it.isNotBlank() } ?: return ""
      return "remote:${remote.libraryId}\u0000${remote.itemId}\u0000$mediaSource"
    }
    stream.localPath?.takeIf { it.isNotBlank() }?.let { return "local:$it" }
    return stream.sourceId.takeIf { it.isNotBlank() }?.let { "source:$it" } ?: ""
  }

  /** [rows] without a row whose identity already appeared in [seen], which is extended in place,
   *  and without a row that names nothing at all. */
  fun deduped(rows: List<StreamDto>, seen: MutableSet<String> = HashSet()): List<StreamDto> =
    rows.filter { rowIdentity(it).isNotBlank() }.filter { seen.add(rowIdentity(it)) }

  /** One remote group choice: its filter value, its label and how many rows it holds. */
  data class RemoteGroupCount(val value: String, val label: String, val count: Int)

  /**
   * The rows a detail already holds, before any supplementary group answers: a native item's own
   * versions, or the copies a library detail was opened on. They are ordinary rows of the list --
   * they obey the same source choice and the same size sorts -- and they lead the rule and
   * addon-priority orders. [libraryId] names the media-server library they are versions of, so the
   * addon filter can offer that library and choosing it answers with exactly these rows; it is null
   * when the rows are copies on disk, which belong to the Local choice instead.
   */
  data class Origins(
    val rows: List<StreamDto> = emptyList(),
    val libraryId: String? = null,
    val label: String = "",
  )

  /**
   * The list a source panel shows, as the web builds it. [addon] is already filtered and sorted.
   * The Local choice of the addon filter shows the library copies alone, and a named addon shows
   * its streams alone. With no addon filter, a rule that carries verdicts sorts the library
   * copies, the remote versions and the addon rows together by that rank. The server already
   * puts a local copy first only when the rule uses the viewer's order, so this list does not
   * prepend one. Without a verdict the copies still lead, then the remote versions, then the
   * addon rows. Size and addon sorts are unchanged. [origins], the item's own versions, stay
   * ahead of that merge under a rule sort and use the same rank order among themselves.
   *
   * [local] is the copies the caller did not already hand over as [origins], so a file the detail
   * holds and the viewer's library both know is one row of the list, not two.
   *
   * A media-server origin is offered through its library's own group, so a named provider other
   * than that library hides it exactly as it hides every other library's versions.
   */
  fun catalogSourceList(
    local: List<StreamDto>,
    addon: List<StreamDto>,
    filters: StreamFilters = StreamFilters(),
    preferredLanguage: String = "en",
    priority: Map<String, Int> = emptyMap(),
    titleLanguage: String? = null,
    remote: List<RemoteGroup> = emptyList(),
    origins: Origins = Origins(),
  ): List<StreamDto> = when {
    filters.addon == LOCAL_FILTER -> origins.rows.filter { isLocalStream(it) } + local
    // The item's own library answers with the rows the detail holds, which are not among the
    // groups the supplementary discovery matched.
    originFilterLibrary(filters.addon, origins) != null -> origins.rows
    // A remote filter shows that one library's matched versions, even when it matched nothing.
    remoteFilterLibrary(filters.addon) != null ->
      remote.firstOrNull { it.libraryId == remoteFilterLibrary(filters.addon) }?.streams.orEmpty()
    filters.addon.isNotEmpty() -> addon
    filters.sort == StreamSort.Addon ->
      origins.rows + local + remote.flatMap { it.streams } + addon
    filters.sort.isRuleSort -> {
      val profileId = ruleIdOf(filters.sort)
      val merged = local + remote.flatMap { it.streams } + addon
      val byRule = { rows: List<StreamDto> ->
        if (profileId != null && rows.any { it.rules[profileId] != null }) {
          rows.sortedWith { a, b -> compareRuleRank(a, b, profileId) }
        } else {
          rows
        }
      }
      byRule(origins.rows) + byRule(merged)
    }
    else -> arrangeStreams(
      origins.rows + remote.flatMap { it.streams } + addon + local,
      StreamFilters(sort = filters.sort),
      preferredLanguage,
      priority,
      titleLanguage,
    )
  }

  /** The origin library a filter value names, or null when the value names anything else. */
  private fun originFilterLibrary(value: String, origins: Origins): String? =
    origins.libraryId?.takeIf { it.isNotBlank() && value == remoteFilter(it) }

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
    isRemoteStream(stream) -> "REMOTE"
    stream.playable -> "HTTP"
    stream.kind == "torrent" -> "RD"
    else -> "EXT"
  }

  /** Whether the server may queue this source into a library the viewer writes to. A media-server
   *  version is never queueable: it lives on the remote server and cannot be downloaded through
   *  this app. Existing filesystem and addon behaviour is unchanged. */
  /**
   * A copy that is already on disk is never queued again. A remote media-server original may be
   * copied into a local library only when the server projected the account's native download
   * right on that exact source: a playable version is not enough. Every other source keeps the
   * addon rule, and a torrent still needs Real-Debrid.
   */
  fun canQueue(stream: StreamDto, debridConfigured: Boolean): Boolean {
    if (isLocalStream(stream)) return false
    if (isRemoteStream(stream)) return stream.playable && stream.capabilities?.downloadToLibrary == true
    return stream.playable || (stream.kind == "torrent" && debridConfigured)
  }

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
    /** The remote library groups the addon filter offers. */
    val remoteGroups: List<RemoteGroupCount> = emptyList(),
  )

  fun filterOptions(
    listed: List<StreamDto>,
    filters: StreamFilters,
    priority: Map<String, Int> = emptyMap(),
    titleLanguage: String? = null,
    localCount: Int = 0,
    remote: List<RemoteGroup> = emptyList(),
    origins: Origins = Origins(),
  ): SourceFilterOptions {
    val byLanguage = if (filters.language.isEmpty()) listed
    else listed.filter { streamLanguages(it, titleLanguage).contains(filters.language) }
    val byAddon = if (filters.addon.isEmpty()) listed
    else listed.filter { it.addonName == filters.addon }

    val addonCounts = LinkedHashMap<String, Int>()
    for (stream in byLanguage) {
      // A remote version is offered through its own group choice, never under an addon name.
      if (isRemoteStream(stream)) continue
      val name = stream.addonName ?: "?"
      addonCounts[name] = (addonCounts[name] ?: 0) + 1
    }
    // The chosen addon stays in the menu even when the language filter left it nothing, or the chip would empty.
    val chosenRemote = remoteFilterLibrary(filters.addon)
    if (filters.addon.isNotEmpty() && filters.addon != LOCAL_FILTER && chosenRemote == null && !addonCounts.containsKey(filters.addon)) addonCounts[filters.addon] = 0
    val addons = addonCounts.map { StreamCount(it.key, it.value) }
      .sortedWith(compareBy({ priority[it.value] ?: Int.MAX_VALUE }, { -it.count }))

    val languageCounts = LinkedHashMap<String, Int>()
    for (stream in byAddon) for (code in streamLanguages(stream, titleLanguage)) {
      languageCounts[code] = (languageCounts[code] ?: 0) + 1
    }
    if (filters.language.isNotEmpty() && !languageCounts.containsKey(filters.language)) languageCounts[filters.language] = 0
    val languages = languageCounts.map { StreamCount(it.key, it.value) }.sortedByDescending { it.count }

    // The item's own library leads the choices -- it is what the detail is showing -- then every
    // group with a match; one that is chosen stays visible even when it matched nothing.
    val ownGroup = origins.libraryId?.takeIf { it.isNotBlank() && origins.rows.isNotEmpty() }
      ?.let { RemoteGroupCount(remoteFilter(it), origins.label, origins.rows.size) }
    val remoteGroups = listOfNotNull(ownGroup) + remote
      .filter { it.streams.isNotEmpty() || chosenRemote == it.libraryId }
      .map { RemoteGroupCount(remoteFilter(it.libraryId), it.label, it.streams.size) }
    return SourceFilterOptions(addons, languages, localCount, remoteGroups)
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
    remote: List<RemoteGroup> = emptyList(),
    origins: Origins = Origins(),
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
      options = filterOptions(
        listed,
        filters,
        priority,
        titleLanguage,
        localCount = local.size + origins.rows.count { isLocalStream(it) },
        remote = remote,
        origins = origins,
      ),
      rows = catalogSourceList(local, visible, filters, preferredLanguage, priority, titleLanguage, remote, origins),
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
