package cz.stremiooffline.tv.ui.home

import androidx.annotation.StringRes
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.DownloadDto
import cz.stremiooffline.tv.ui.catalog.formatSize
import kotlin.math.floor

enum class QueueGroup { Attention, Paused, Active, Waiting, Queued }

private val GROUP_ORDER = mapOf(
  QueueGroup.Attention to 0,
  QueueGroup.Paused to 1,
  QueueGroup.Active to 2,
  QueueGroup.Waiting to 3,
  QueueGroup.Queued to 4,
)

private val BLOCKED_REASONS = setOf("storage", "library", "permission")

/** No space, a library that is away or a right that was taken back: the account cannot fix
 *  this from Home, so the summary counts it as needing attention. */
fun blocked(job: DownloadDto): Boolean =
  job.status == "paused" && (job.pauseReason in BLOCKED_REASONS || job.libraryGone == true)

fun queueGroup(job: DownloadDto): QueueGroup = when {
  job.status == "failed" || blocked(job) -> QueueGroup.Attention
  job.status == "paused" -> QueueGroup.Paused
  job.status == "checking" || job.status == "downloading" -> QueueGroup.Active
  job.status == "waiting" -> QueueGroup.Waiting
  else -> QueueGroup.Queued
}

/** The account's own jobs, completed ones left out, in the row's fixed order. The byte count
 *  never decides a position, so a poll cannot shuffle the cards. */
fun homeQueue(jobs: List<DownloadDto>): List<DownloadDto> {
  val byGroup = compareBy<DownloadDto>({ GROUP_ORDER.getValue(queueGroup(it)) }, { it.order }, { it.id })
  return jobs.filter { it.mine == true && it.status != "completed" }.sortedWith(byGroup)
}

/** The jobs the row marks red: failed, or blocked outside the account's control. */
fun attentionCount(jobs: List<DownloadDto>): Int =
  homeQueue(jobs).count { queueGroup(it) == QueueGroup.Attention }

/** The status word of one job; a blocked pause counts as paused. */
@StringRes fun queueStatusRes(job: DownloadDto): Int = when (job.status) {
  "waiting" -> R.string.downloads_status_waiting
  "checking" -> R.string.downloads_status_checking
  "downloading" -> R.string.downloads_status_downloading
  "paused" -> R.string.downloads_status_paused
  "failed" -> R.string.downloads_status_failed
  else -> R.string.downloads_status_queued
}

/** The status word, percentage, total size and, while downloading, speed. */
fun queueLine(job: DownloadDto, status: String): String {
  val parts = mutableListOf(status)
  val total = job.total
  if (total != null && total > 0) {
    val percent = floor((job.received ?: 0.0) / total * 100).toInt().coerceIn(0, 100)
    parts += "$percent %"
    formatSize(total)?.let(parts::add)
  }
  val speed = job.speed
  if (job.status == "downloading" && speed != null && speed > 0) {
    formatSize(speed)?.let { parts += "$it/s" }
  }
  return parts.joinToString(" · ")
}
