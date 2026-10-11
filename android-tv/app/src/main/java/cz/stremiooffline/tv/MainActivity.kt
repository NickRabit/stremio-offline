package cz.stremiooffline.tv

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.appcompat.app.AppCompatActivity
import cz.stremiooffline.tv.ui.AppRoot
import cz.stremiooffline.tv.ui.theme.StremioTheme

/** An AppCompatActivity so `AppCompatDelegate.setApplicationLocales` can carry the per-app
 *  interface language on every API level, not only from Android 13 up. */
class MainActivity : AppCompatActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      StremioTheme {
        AppRoot()
      }
    }
  }
}
