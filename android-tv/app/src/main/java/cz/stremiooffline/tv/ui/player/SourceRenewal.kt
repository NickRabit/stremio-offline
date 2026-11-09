package cz.stremiooffline.tv.ui.player

import cz.stremiooffline.tv.catalog.Streams
import cz.stremiooffline.tv.data.StreamDto

/**
 * The server keeps a listed source for 30 minutes and answers an older id with 410. A row is
 * trusted only well inside that window, the same rule the web's next-episode prefetch keeps.
 */
internal const val SOURCES_FRESH_MS = 20 * 60_000L

/** A row the server minted an id for. A local copy is minted again from its path at every start,
 *  so its listed id never goes stale. */
private fun expires(row: StreamDto): Boolean = row.sourceId.isNotBlank() && !Streams.isLocalStream(row)

/** Whether any row of [rows] was listed so long ago that the server may already have dropped it. */
internal fun sourcesStale(rows: List<StreamDto>, listedAt: Map<String, Long>, now: Long): Boolean =
  rows.any { expires(it) && listedAt[it.sourceId]?.let { at -> now - at >= SOURCES_FRESH_MS } == true }

/** One version across two listings: the server's stable handle when both carry one, otherwise the
 *  media-server identity, otherwise the addon row as it is drawn. The source id is the one thing
 *  that changes, so it never decides. */
internal fun sameSource(old: StreamDto, fresh: StreamDto): Boolean {
  if (!old.stableKey.isNullOrBlank() && !fresh.stableKey.isNullOrBlank()) return old.stableKey == fresh.stableKey
  val identity = Streams.rowIdentity(old)
  if (!identity.startsWith("source:") && identity.isNotEmpty()) return identity == Streams.rowIdentity(fresh)
  return old.remoteItem == null && fresh.remoteItem == null &&
    (old.addonKey ?: old.addonName) == (fresh.addonKey ?: fresh.addonName) &&
    old.name == fresh.name && old.title == fresh.title &&
    old.behaviorHints?.filename == fresh.behaviorHints?.filename
}

/** [old] with every row the new listing names again taken from it, in the order [old] had, and the
 *  rows only the new listing has after them. A row the new listing lost stays as it was. */
internal fun renewedRows(old: List<StreamDto>, fresh: List<StreamDto>): List<StreamDto> {
  val taken = HashSet<Int>()
  val kept = old.map { row ->
    if (!expires(row)) return@map row
    val index = fresh.indices.firstOrNull { it !in taken && sameSource(row, fresh[it]) } ?: return@map row
    taken += index
    fresh[index]
  }
  return kept + fresh.filterIndexed { index, row -> index !in taken && old.none { (it.sourceId.isNotBlank() && it.sourceId == row.sourceId) || sameSource(it, row) } }
}
