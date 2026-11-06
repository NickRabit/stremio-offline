package cz.stremiooffline.tv.ui.downloads

import androidx.annotation.StringRes
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.DownloadDto
import kotlin.math.ceil
import kotlin.math.floor

/** Downloading, checking sources, or waiting for Real-Debrid. */
fun isActive(job: DownloadDto): Boolean = job.status in ActiveStatuses

/** The active jobs in queue order (`order`, then `id`), so a poll never shuffles rows. */
fun activeJobs(jobs: List<DownloadDto>): List<DownloadDto> =
  jobs.filter(::isActive).sortedWith(compareBy<DownloadDto> { it.order }.thenBy { it.id })

private val ActiveStatuses = setOf("downloading", "checking", "waiting")

data class QueueCounts(val queued: Int, val paused: Int, val failed: Int)

/** queued = status "queued"; paused = "paused"; failed = "failed". Completed and active are not counted. */
fun queueCounts(jobs: List<DownloadDto>): QueueCounts = QueueCounts(
  queued = jobs.count { it.status == "queued" },
  paused = jobs.count { it.status == "paused" },
  failed = jobs.count { it.status == "failed" },
)

/** 0..100, floor. `waiting` -> `debridProgress` (coerced 0..100) or null;
 *  otherwise received/total when total > 0, else null. */
fun activePercent(job: DownloadDto): Int? {
  if (job.status == "waiting") return job.debridProgress?.coerceIn(0.0, 100.0)?.let(::floor)?.toInt()
  val total = job.total ?: return null
  if (total <= 0.0) return null
  return floor((job.received ?: 0.0) / total * 100.0).toInt().coerceIn(0, 100)
}

/** Sum of `speed` over active jobs with status "downloading". */
fun totalSpeed(jobs: List<DownloadDto>): Double =
  jobs.filter { it.status == "downloading" }.sumOf { it.speed ?: 0.0 }

/** Seconds left: (total - received) / speed, only for "downloading" with speed > 0 and total > 0. */
fun etaSeconds(job: DownloadDto): Double? {
  if (job.status != "downloading") return null
  val total = job.total ?: return null
  val speed = job.speed ?: return null
  if (total <= 0.0 || speed <= 0.0) return null
  return (total - (job.received ?: 0.0)) / speed
}

/** Same rounding as web `fmtEta` in web/src/download-format.ts. */
fun formatEta(seconds: Double): String {
  val whole = ceil(seconds).coerceAtLeast(0.0).toLong()
  if (whole < 60) return "$whole s"
  val minutes = ceil(whole / 60.0).toLong()
  return if (minutes < 60) "$minutes min" else "${minutes / 60} h ${minutes % 60} min"
}

@StringRes fun queueStatusRes(job: DownloadDto): Int = when (job.status) {
  "waiting" -> R.string.downloads_status_waiting
  "checking" -> R.string.downloads_status_checking
  "downloading" -> R.string.downloads_status_downloading
  "paused" -> R.string.downloads_status_paused
  "failed" -> R.string.downloads_status_failed
  else -> R.string.downloads_status_queued
}
