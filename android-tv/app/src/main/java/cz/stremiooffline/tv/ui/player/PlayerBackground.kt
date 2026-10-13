package cz.stremiooffline.tv.ui.player

/** Home and Recents set this before the activity stops. A screensaver does not: its activity is
 *  started with `FLAG_ACTIVITY_NO_USER_ACTION`, so [android.app.Activity.onUserLeaveHint] is skipped. */
internal object PlayerLeave {
  var requested: Boolean = false
}

/** The system dream broadcasts. An older platform can still report the screensaver as a user
 *  leave; the broadcast is what keeps the session through that stop. */
internal object PlayerDream {
  var active: Boolean = false
}

/**
 * The session is released when the viewer leaves or the screen goes off. A screensaver stops the
 * activity while the screen stays on and nobody has left, and releasing it there made the remote
 * dead until a new session had been opened.
 */
internal fun releasePlaybackOnStop(userLeaving: Boolean, screenInteractive: Boolean, dreaming: Boolean): Boolean =
  !screenInteractive || (!dreaming && userLeaving)
