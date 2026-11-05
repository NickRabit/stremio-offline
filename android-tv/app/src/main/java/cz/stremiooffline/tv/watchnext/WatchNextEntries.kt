package cz.stremiooffline.tv.watchnext

import cz.stremiooffline.tv.data.HomeCard
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.roundToLong

data class WatchNextEntry(
  val key: String,
  val title: String,
  val season: Int?,
  val episode: Int?,
  val positionMs: Long,
  val durationMs: Long,
  val lastEngagementMs: Long,
  val artPath: String?,
  val wideArt: Boolean,
)

fun watchNextEntries(cards: List<HomeCard>, now: Long, limit: Int = 20): List<WatchNextEntry> {
  if (limit <= 0) return emptyList()
  return cards.asSequence().mapNotNull { card ->
    when (card) {
      is HomeCard.ResumeFile -> card.entry(now, card.title)
      is HomeCard.ResumeCatalogue -> card.entry(now, card.name.takeIf { it.isNotBlank() } ?: card.title)
      else -> null
    }
  }.take(limit).toList()
}

private fun HomeCard.ResumeFile.entry(now: Long, title: String): WatchNextEntry? {
  val progress = progress ?: return null
  if (!progress.isResumable()) return null
  if (title.isBlank()) return null
  val art = poster.takeIf { !it.isNullOrBlank() }?.let { it to false }
    ?: wide.takeIf { !it.isNullOrBlank() }?.let { it to true }
  return WatchNextEntry(
    key = key,
    title = title,
    season = season,
    episode = episode,
    positionMs = progress.position.millis(),
    durationMs = progress.duration.millis(),
    lastEngagementMs = updatedAt.millisOr(now),
    artPath = art?.first,
    wideArt = art?.second ?: false,
  )
}

private fun HomeCard.ResumeCatalogue.entry(now: Long, title: String): WatchNextEntry? {
  val progress = progress ?: return null
  if (!progress.isResumable()) return null
  if (title.isBlank()) return null
  val art = poster.takeIf { !it.isNullOrBlank() }?.let { it to false }
    ?: wide.takeIf { !it.isNullOrBlank() }?.let { it to true }
  return WatchNextEntry(
    key = key,
    title = title,
    season = season,
    episode = episode,
    positionMs = progress.position.millis(),
    durationMs = progress.duration.millis(),
    lastEngagementMs = updatedAt.millisOr(now),
    artPath = art?.first,
    wideArt = art?.second ?: false,
  )
}

private fun cz.stremiooffline.tv.data.HomeProgress.isResumable(): Boolean =
  duration > 0 && position > 0 && position < duration * 0.95

private fun Double.millis(): Long = (this * 1_000.0).roundToLong()

private fun String?.millisOr(fallback: Long): Long =
  this?.let {
    runCatching {
      OffsetDateTime.parse(it, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toInstant().toEpochMilli()
    }.getOrNull()
  } ?: fallback

data class ExistingProgram(val id: Long, val key: String, val browsable: Boolean)

data class WatchNextPlan(
  val insert: List<WatchNextEntry>,
  val update: List<Pair<Long, WatchNextEntry>>,
  val delete: List<Long>,
)

fun planWatchNext(existing: List<ExistingProgram>, entries: List<WatchNextEntry>): WatchNextPlan {
  val retained = linkedMapOf<String, ExistingProgram>()
  val delete = mutableListOf<Long>()
  for (program in existing) {
    if (program.key.isBlank()) {
      delete += program.id
    } else if (retained.putIfAbsent(program.key, program) != null) {
      delete += program.id
    }
  }

  val byKey = entries.associateBy { it.key }
  val update = retained.values.mapNotNull { program ->
    val entry = byKey[program.key]
    when {
      entry == null -> {
        delete += program.id
        null
      }
      program.browsable -> program.id to entry
      else -> null
    }
  }
  return WatchNextPlan(
    insert = entries.filter { it.key !in retained },
    update = update,
    delete = delete,
  )
}

fun watchNextLink(key: String): String =
  "stremiooffline://watchnext?key=" + URLEncoder.encode(key, StandardCharsets.UTF_8.name())

fun watchNextKey(link: String?): String? {
  val uri = link?.let { runCatching { URI(it) }.getOrNull() } ?: return null
  if (!uri.scheme.equals("stremiooffline", ignoreCase = true)) return null
  if (!uri.host.equals("watchnext", ignoreCase = true)) return null
  val rawKey = uri.rawQuery
    ?.split('&')
    ?.firstOrNull { it.substringBefore('=') == "key" }
    ?.substringAfter('=', "")
    ?: return null
  return runCatching {
    URLDecoder.decode(rawKey, StandardCharsets.UTF_8.name())
  }.getOrNull()?.takeIf { it.isNotBlank() }
}

fun watchNextArtName(artPath: String): String {
  val digest = MessageDigest.getInstance("SHA-1").digest(artPath.toByteArray(StandardCharsets.UTF_8))
  return digest.joinToString(separator = "") { byte ->
    "%02x".format(Locale.US, byte.toInt() and 0xff)
  } + ".jpg"
}
