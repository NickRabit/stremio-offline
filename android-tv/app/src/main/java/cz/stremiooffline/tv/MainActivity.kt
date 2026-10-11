package cz.stremiooffline.tv

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.appcompat.app.AppCompatActivity
import cz.stremiooffline.tv.diagnostics.AppLog
import cz.stremiooffline.tv.ui.AppRoot
import cz.stremiooffline.tv.ui.theme.StremioTheme

/** An AppCompatActivity so `AppCompatDelegate.setApplicationLocales` can carry the per-app
 *  interface language on every API level, not only from Android 13 up. */
class MainActivity : AppCompatActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // The crash of a run that dies is written before the process goes, for the next start to send.
    AppLog.installCrashHandler(AppLog.crashFile(filesDir))
    setContent {
      StremioTheme {
        AppRoot()
      }
    }
  }

  override fun onStart() {
    super.onStart()
    AppLog.info("App start")
  }

  override fun onStop() {
    AppLog.info("App stop")
    super.onStop()
  }
}
