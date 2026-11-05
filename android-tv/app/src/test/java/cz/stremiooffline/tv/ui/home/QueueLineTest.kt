package cz.stremiooffline.tv.ui.home

import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.DownloadDto
import org.junit.Assert.assertEquals
import org.junit.Test

class QueueLineTest {

  private fun job(
    status: String = "downloading",
    received: Double? = null,
    total: Double? = null,
    speed: Double? = null,
    pauseReason: String? = null,
  ) = DownloadDto(
    status = status,
    received = received,
    total = total,
    speed = speed,
    pauseReason = pauseReason,
  )

  @Test
  fun `every status maps to its status word`() {
    assertEquals(R.string.downloads_status_queued, queueStatusRes(job(status = "queued")))
    assertEquals(R.string.downloads_status_waiting, queueStatusRes(job(status = "waiting")))
    assertEquals(R.string.downloads_status_checking, queueStatusRes(job(status = "checking")))
    assertEquals(R.string.downloads_status_downloading, queueStatusRes(job(status = "downloading")))
    assertEquals(R.string.downloads_status_paused, queueStatusRes(job(status = "paused")))
    assertEquals(R.string.downloads_status_failed, queueStatusRes(job(status = "failed")))
    assertEquals(R.string.downloads_status_queued, queueStatusRes(job(status = "unknown")))
  }

  @Test
  fun `a blocked pause uses the paused status word`() {
    assertEquals(
      R.string.downloads_status_paused,
      queueStatusRes(job(status = "paused", pauseReason = "storage")),
    )
  }

  @Test
  fun `the line floors progress and includes the total and speed`() {
    val line = queueLine(
      job(received = 459_000_000.0, total = 1_000_000_000.0, speed = 3_400_000.0),
      "Downloading",
    )

    assertEquals("Downloading · 45 % · 1.0 GB · 3 MB/s", line)
  }

  @Test
  fun `progress above one hundred is clamped`() {
    val line = queueLine(job(received = 2_000.0, total = 1_000.0), "Downloading")

    assertEquals("Downloading · 100 % · 1 kB", line)
  }

  @Test
  fun `without a total the line has only the status`() {
    val line = queueLine(job(status = "queued", received = 1_000.0, speed = 3_000_000.0), "Queued")

    assertEquals("Queued", line)
  }

  @Test
  fun `speed is omitted when the job is not downloading`() {
    val line = queueLine(job(status = "paused", total = 1_000.0, speed = 3_000_000.0), "Paused")

    assertEquals("Paused · 0 % · 1 kB", line)
  }

  @Test
  fun `zero speed is omitted while downloading`() {
    val line = queueLine(job(total = 1_000.0, speed = 0.0), "Downloading")

    assertEquals("Downloading · 0 % · 1 kB", line)
  }
}
