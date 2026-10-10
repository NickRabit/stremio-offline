package cz.stremiooffline.tv

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import cz.stremiooffline.tv.ui.AppRoot
import cz.stremiooffline.tv.ui.theme.StremioTheme

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      StremioTheme {
        AppRoot()
      }
    }
  }
}
