package cz.stremiooffline.tv.ui.player

import androidx.compose.ui.input.key.Key

/** The remote keys the player itself reacts to, free of Android types so the rules can be tested. */
enum class PlayerKey { Center, Left, Right, Up, Down, Back }

/** The five-way pad and Back, mapped onto the pure rules. */
fun playerKeyOf(key: Key): PlayerKey? = when (key) {
  Key.DirectionCenter, Key.Enter -> PlayerKey.Center
  Key.DirectionLeft -> PlayerKey.Left
  Key.DirectionRight -> PlayerKey.Right
  Key.DirectionUp -> PlayerKey.Up
  Key.DirectionDown -> PlayerKey.Down
  Key.Back -> PlayerKey.Back
  else -> null
}

/** What one key does. */
data class PlayerKeyIntent(
  val pausePlayback: Boolean = false,
  val showControls: Boolean = false,
  val hideControls: Boolean = false,
  /** -1 rewinds, +1 forwards; the distance comes from how long the key is held. */
  val seekDirection: Int? = null,
  val exit: Boolean = false,
)

/** The step every playback seek uses, in seconds. */
const val SEEK_STEP_SECONDS = 10.0

/**
 * The step of one seek press: a tap is ten seconds, and a key held longer than a second takes
 * bigger bites so a long film does not need a hundred presses.
 */
fun seekStep(heldMs: Long): Double = when {
  heldMs < 1_000 -> 10.0
  heldMs < 3_000 -> 30.0
  heldMs < 6_000 -> 60.0
  else -> 120.0
}

/**
 * The prototype's key map. With the controls hidden the five-way pad drives playback directly;
 * with them shown only Back is the player's, so the arrows move focus between the controls.
 * A null answer means the focused control owns the key.
 */
fun playerKeyIntent(key: PlayerKey, controlsShown: Boolean): PlayerKeyIntent? = when (key) {
  PlayerKey.Back -> if (controlsShown) PlayerKeyIntent(hideControls = true) else PlayerKeyIntent(exit = true)
  PlayerKey.Center -> if (controlsShown) null else PlayerKeyIntent(pausePlayback = true, showControls = true)
  PlayerKey.Left -> if (controlsShown) null else PlayerKeyIntent(seekDirection = -1)
  PlayerKey.Right -> if (controlsShown) null else PlayerKeyIntent(seekDirection = 1)
  PlayerKey.Up, PlayerKey.Down -> if (controlsShown) null else PlayerKeyIntent(showControls = true)
}
