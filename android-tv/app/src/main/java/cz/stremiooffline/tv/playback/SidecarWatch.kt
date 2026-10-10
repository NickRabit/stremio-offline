package cz.stremiooffline.tv.playback

/** The web's polling numbers from `player-sidecar.ts`. */
const val SIDECAR_POLL_MS = 250L
const val SIDECAR_SETTLED_POLL_MS = 5_000L
const val SIDECAR_REFRESH_LEAD_S = 45.0

/** How much of the sidecar has been taken on and how many passes it took. */
data class SidecarState(val pass: Int = -1, val attached: Double = Double.NEGATIVE_INFINITY)

/**
 * `watchSidecar`'s rule: the cues are attached once the reader is ahead of the picture, read
 * again before the picture catches up with them, and a last time when the reader has the rest.
 */
fun sidecarRefresh(state: SidecarState, coverage: Double, complete: Boolean, position: Double): Boolean {
  val attachedShort = state.attached < position + SIDECAR_REFRESH_LEAD_S
  val reached = if (complete) Double.POSITIVE_INFINITY else coverage
  val newWindow = reached > state.attached &&
    (position >= state.attached || (attachedShort && reached >= position + SIDECAR_REFRESH_LEAD_S))
  return state.pass < 0 || complete || newWindow
}

/** The state after a read worth attaching; only call it when [sidecarRefresh] said so. */
fun sidecarAdvanced(state: SidecarState, coverage: Double, complete: Boolean): SidecarState =
  SidecarState(state.pass + 1, if (complete) Double.POSITIVE_INFINITY else coverage)

/** How long to wait before the next poll: closely until the cues are ahead of the picture. */
fun sidecarPollDelay(state: SidecarState, position: Double): Long =
  if (state.pass < 0 || state.attached < position + SIDECAR_REFRESH_LEAD_S) SIDECAR_POLL_MS else SIDECAR_SETTLED_POLL_MS
