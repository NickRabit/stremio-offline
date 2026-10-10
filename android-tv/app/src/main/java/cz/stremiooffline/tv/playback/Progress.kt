package cz.stremiooffline.tv.playback

/** The web's progress rules, shared by the library and the player. */
object Progress {
  /** Positions between the start and the last five per cent are the only ones worth resuming. */
  const val MIN_RESUME_SECONDS = 30.0
  const val COMPLETE_RATIO = 0.94

  /** The canonical key of one library file, exactly as the web builds it. */
  fun libraryKey(path: String): String = "file:$path"

  fun isCompleted(position: Double, duration: Double): Boolean =
    duration > 0 && position / duration > COMPLETE_RATIO

  /** The position to resume at, or null when the stored one is too early or already finished. */
  fun resumePosition(position: Double, duration: Double): Double? =
    position.takeIf { it >= MIN_RESUME_SECONDS && !isCompleted(position, duration) }
}
