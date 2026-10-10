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

/** What one key does. `seekSeconds` is negative for a rewind. */
data class PlayerKeyIntent(
  val pausePlayback: Boolean = false,
  val showControls: Boolean = false,
  val hideControls: Boolean = false,
  val seekSeconds: Double? = null,
  val exit: Boolean = false,
)

/** The step every playback seek uses, in seconds. */
const val SEEK_STEP_SECONDS = 10.0

/**
 * The prototype's key map. With the controls hidden the five-way pad drives playback directly;
 * with them shown only Back is the player's, so the arrows move focus between the controls.
 * A null answer means the focused control owns the key.
 */
fun playerKeyIntent(key: PlayerKey, controlsShown: Boolean): PlayerKeyIntent? = when (key) {
  PlayerKey.Back -> if (controlsShown) PlayerKeyIntent(hideControls = true) else PlayerKeyIntent(exit = true)
  PlayerKey.Center -> if (controlsShown) null else PlayerKeyIntent(pausePlayback = true, showControls = true)
  PlayerKey.Left -> if (controlsShown) null else PlayerKeyIntent(seekSeconds = -SEEK_STEP_SECONDS)
  PlayerKey.Right -> if (controlsShown) null else PlayerKeyIntent(seekSeconds = SEEK_STEP_SECONDS)
  PlayerKey.Up, PlayerKey.Down -> if (controlsShown) null else PlayerKeyIntent(showControls = true)
}
