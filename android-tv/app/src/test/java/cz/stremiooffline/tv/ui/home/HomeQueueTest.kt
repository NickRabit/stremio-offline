package cz.stremiooffline.tv.ui.home

import cz.stremiooffline.tv.data.DownloadDto
import org.junit.Assert.assertEquals
import org.junit.Test

/** The cases of `web/src/home-rows.test.ts` that cover what the Home strip reads. */
class HomeQueueTest {

  private fun job(
    id: String,
    status: String = "queued",
    order: Int = 0,
    mine: Boolean? = true,
    pauseReason: String? = null,
    libraryGone: Boolean? = null,
  ) = DownloadDto(id = id, title = id, status = status, order = order, mine = mine, pauseReason = pauseReason, libraryGone = libraryGone)

  @Test
  fun `keeps the account's own jobs and drops everybody else's`() {
    val queue = homeQueue(listOf(job("mine", mine = true), job("theirs", mine = false), job("unknown", mine = null)))

    assertEquals(listOf("mine"), queue.map { it.id })
  }

  @Test
  fun `leaves completed jobs out`() {
    assertEquals(listOf("queued"), homeQueue(listOf(job("done", status = "completed"), job("queued"))).map { it.id })
  }

  @Test
  fun `orders attention, paused, active, waiting, queued`() {
    val queue = homeQueue(
      listOf(
        job("queued", status = "queued"),
        job("waiting", status = "waiting"),
        job("active", status = "downloading"),
        job("paused", status = "paused", pauseReason = "user"),
        job("failed", status = "failed"),
      ),
    )

    assertEquals(listOf("failed", "paused", "active", "waiting", "queued"), queue.map { it.id })
  }

  @Test
  fun `keeps a blocked job in the attention group and a failed one beside it`() {
    val queue = homeQueue(listOf(job("blocked", status = "paused", pauseReason = "storage"), job("failed", status = "failed")))

    assertEquals(listOf(QueueGroup.Attention, QueueGroup.Attention), queue.map { queueGroup(it) })
  }

  @Test
  fun `orders a group by the stored order and then the id`() {
    val queue = homeQueue(
      listOf(
        job("b", status = "downloading", order = 1),
        job("a", status = "downloading", order = 1),
        job("first", status = "downloading", order = 0),
      ),
    )

    assertEquals(listOf("first", "a", "b"), queue.map { it.id })
  }

  @Test
  fun `does not reorder a group when a byte count changes`() {
    val before = listOf(job("a", status = "downloading", order = 0), job("b", status = "downloading", order = 1))
    val order = homeQueue(before).map { it.id }

    assertEquals(order, homeQueue(before.reversed()).map { it.id })
  }

  @Test
  fun `counts failed and blocked jobs of the account, and nothing else`() {
    val count = attentionCount(
      listOf(
        job("failed", status = "failed"),
        job("blocked", status = "paused", pauseReason = "permission"),
        job("running", status = "downloading"),
        job("theirs", status = "failed", mine = false),
        job("done", status = "completed"),
      ),
    )

    assertEquals(2, count)
  }

  @Test
  fun `a paused job with a missing library is blocked`() {
    assertEquals(true, blocked(job("gone", status = "paused", pauseReason = "user", libraryGone = true)))
    assertEquals(false, blocked(job("user", status = "paused", pauseReason = "user")))
    assertEquals(false, blocked(job("running", status = "downloading")))
  }
}
