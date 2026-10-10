package cz.stremiooffline.tv.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SubtitleLogicTest {

  @Test
  fun `a press of a quarter of a second moves the delay and stays inside the limit`() {
    assertEquals(0.25, SubtitleDelay.nudge(0.0, SubtitleDelay.STEP_S), 0.0001)
    assertEquals(0.0, SubtitleDelay.nudge(-0.25, SubtitleDelay.STEP_S), 0.0001)
    assertEquals(-0.5, SubtitleDelay.nudge(-0.25, -SubtitleDelay.STEP_S), 0.0001)
    // A value that would pass the limit is clamped, not wrapped.
    assertEquals(SubtitleDelay.LIMIT_S, SubtitleDelay.nudge(SubtitleDelay.LIMIT_S, SubtitleDelay.STEP_S), 0.0001)
    assertEquals(-SubtitleDelay.LIMIT_S, SubtitleDelay.nudge(-SubtitleDelay.LIMIT_S, -SubtitleDelay.STEP_S), 0.0001)
  }

  @Test
  fun `the delay is formatted with two decimals and a sign`() {
    assertEquals("+0.25 s", SubtitleDelay.format(0.25))
    assertEquals("-0.50 s", SubtitleDelay.format(-0.5))
    assertEquals("+30.00 s", SubtitleDelay.format(30.0))
  }

  @Test
  fun `the addon and sidecar addresses match the web`() {
    assertEquals("/api/subtitle/abc", SubtitleUrls.addon("abc", 0.0, 0.0))
    assertEquals("/api/subtitle/abc?offset=120.000&delay=0.25", SubtitleUrls.addon("abc", 120.0, 0.25))
    assertEquals("/sidecar.vtt?revision=1&offset=0.000&position=12.500", SubtitleUrls.sidecar("/sidecar.vtt?revision=1&offset=0.000", 12.5, 0.0))
    assertEquals("/sidecar.vtt?position=0.000&delay=-0.25", SubtitleUrls.sidecar("/sidecar.vtt", -5.0, -0.25))
  }

  @Test
  fun `a webvtt document is read into cues and the active one is chosen`() {
    val cues = parseVtt(
      """
      WEBVTT

      1
      00:00:01.000 --> 00:00:03.000
      Hello
      world

      00:00:04.500 --> 00:00:06.000
      Bye
      """.trimIndent(),
    )
    assertEquals(2, cues.size)
    assertEquals("Hello\nworld", cues[0].text)
    assertEquals(3.0, cues[0].end, 0.0001)
    assertNull(activeCue(cues, 3.5))
    assertEquals("Bye", activeCue(cues, 5.0))
    assertEquals("Hello\nworld", activeCue(cues, 2.0))
  }

  @Test
  fun `a minute-second timestamp without hours still parses`() {
    val cues = parseVtt("WEBVTT\n\n02:10.500 --> 02:12.000\nAhoj")
    assertEquals(1, cues.size)
    assertEquals(130.5, cues[0].start, 0.0001)
  }

  @Test
  fun `the sidecar is re-read before the picture catches up and once when it is whole`() {
    // The four cases of `player-sidecar.test.ts`, as a sequence of coverage and playhead answers.
    val reads = listOf(
      Triple(600.0, false, 0.0),
      Triple(900.0, false, 100.0),
      Triple(1500.0, false, 580.0),
      Triple(0.0, true, 580.0),
    )
    var state = SidecarState()
    val passes = mutableListOf<Int>()
    for ((coverage, complete, position) in reads) {
      if (sidecarRefresh(state, coverage, complete, position)) {
        state = sidecarAdvanced(state, coverage, complete)
        passes += state.pass
      }
      if (complete) break
    }
    assertEquals(listOf(0, 1, 2), passes)
  }

  @Test
  fun `a short track is not re-read on every poll while the reader catches up`() {
    val reads = listOf(
      Triple(10.0, false, 0.0),
      Triple(15.0, false, 5.0),
      Triple(25.0, false, 9.0),
      Triple(70.0, false, 10.0),
      Triple(0.0, true, 10.0),
    )
    var state = SidecarState()
    val passes = mutableListOf<Int>()
    val waits = mutableListOf<Long>()
    for ((coverage, complete, position) in reads) {
      if (sidecarRefresh(state, coverage, complete, position)) {
        state = sidecarAdvanced(state, coverage, complete)
        passes += state.pass
      }
      if (complete) break
      waits += sidecarPollDelay(state, position)
    }
    assertEquals(listOf(0, 1, 2), passes)
    assertEquals(listOf(SIDECAR_POLL_MS, SIDECAR_POLL_MS, SIDECAR_POLL_MS, SIDECAR_SETTLED_POLL_MS), waits)
  }

  @Test
  fun `the reader having found nothing new does not attach again`() {
    var state = SidecarState()
    state = sidecarAdvanced(state, 600.0, false)
    assertEquals(0, state.pass)
    org.junit.Assert.assertFalse(sidecarRefresh(state, 600.0, false, 10_000.0))
    org.junit.Assert.assertTrue(sidecarRefresh(state, 0.0, true, 10_000.0))
  }
}
