package cz.stremiooffline.tv.ui.downloads

import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.DownloadDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DownloadsModelTest {

  private fun job(
    id: String = "job",
    status: String = "downloading",
    order: Int = 0,
    received: Double? = null,
    total: Double? = null,
    speed: Double? = null,
    debridProgress: Double? = null,
  ) = DownloadDto(
    id = id,
    status = status,
    order = order,
    received = received,
    total = total,
    speed = speed,
    debridProgress = debridProgress,
  )

  @Test
  fun `only downloading checking and waiting jobs are active`() {
    assertTrue(isActive(job(status = "downloading")))
    assertTrue(isActive(job(status = "checking")))
    assertTrue(isActive(job(status = "waiting")))
    assertFalse(isActive(job(status = "queued")))
    assertFalse(isActive(job(status = "paused")))
    assertFalse(isActive(job(status = "failed")))
    assertFalse(isActive(job(status = "completed")))
    assertFalse(isActive(job(status = "unknown")))
  }

  @Test
  fun `active jobs are ordered by queue position then id in either input order`() {
    val jobs = listOf(
      job(id = "b", order = 1),
      job(id = "later", status = "queued", order = 0),
      job(id = "a", order = 1),
      job(id = "first", order = 0),
    )

    assertEquals(listOf("first", "a", "b"), activeJobs(jobs).map { it.id })
    assertEquals(listOf("first", "a", "b"), activeJobs(jobs.reversed()).map { it.id })
  }

  @Test
  fun `queue counts only queued paused and failed jobs`() {
    val counts = queueCounts(
      listOf(
        job(status = "queued"),
        job(status = "queued"),
        job(status = "paused"),
        job(status = "failed"),
        job(status = "downloading"),
        job(status = "checking"),
        job(status = "waiting"),
        job(status = "completed"),
      ),
    )

    assertEquals(QueueCounts(queued = 2, paused = 1, failed = 1), counts)
  }

  @Test
  fun `waiting progress uses only the Real-Debrid percentage`() {
    assertEquals(42, activePercent(job(status = "waiting", debridProgress = 42.9, received = 90.0, total = 100.0)))
    assertNull(activePercent(job(status = "waiting")))
    assertEquals(100, activePercent(job(status = "waiting", debridProgress = 140.0)))
    assertEquals(0, activePercent(job(status = "waiting", debridProgress = -4.0)))
  }

  @Test
  fun `download progress floors received over total and clamps at both ends`() {
    assertEquals(65, activePercent(job(received = 650.0, total = 1_000.0)))
    assertEquals(65, activePercent(job(received = 659.9, total = 1_000.0)))
    assertEquals(100, activePercent(job(received = 1_200.0, total = 1_000.0)))
    assertEquals(0, activePercent(job(received = -20.0, total = 1_000.0)))
    assertNull(activePercent(job(received = 20.0, total = 0.0)))
    assertNull(activePercent(job(received = 20.0)))
  }

  @Test
  fun `total speed adds only downloading jobs`() {
    val speed = totalSpeed(
      listOf(
        job(status = "downloading", speed = 4.0),
        job(status = "downloading", speed = 6.5),
        job(status = "checking", speed = 100.0),
        job(status = "waiting", speed = 200.0),
      ),
    )

    assertEquals(10.5, speed, 0.0)
  }

  @Test
  fun `eta is known only for a positive download speed and a total size`() {
    assertEquals(25.0, etaSeconds(job(received = 750.0, total = 1_000.0, speed = 10.0))!!, 0.0)
    assertEquals(-50.0, etaSeconds(job(received = 1_500.0, total = 1_000.0, speed = 10.0))!!, 0.0)
    assertNull(etaSeconds(job(status = "checking", total = 1_000.0, speed = 10.0)))
    assertNull(etaSeconds(job(total = 1_000.0, speed = 0.0)))
    assertNull(etaSeconds(job(total = 1_000.0)))
    assertNull(etaSeconds(job(total = 0.0, speed = 10.0)))
  }

  @Test
  fun `eta text matches the web rounding`() {
    assertEquals("0 s", formatEta(0.0))
    assertEquals("59 s", formatEta(59.0))
    assertEquals("1 min", formatEta(59.2))
    assertEquals("1 h 0 min", formatEta(3_599.0))
    assertEquals("2 h 1 min", formatEta(7_260.0))
  }

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
}
