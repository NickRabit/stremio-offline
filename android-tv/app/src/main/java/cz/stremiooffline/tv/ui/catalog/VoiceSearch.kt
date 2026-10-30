package cz.stremiooffline.tv.ui.catalog

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import cz.stremiooffline.tv.ui.components.outlineIcon

/** What a mic press needs: [available] is the device's recognizer, [start] asks it for a phrase. */
class VoiceSearch(val available: Boolean, val start: () -> Unit)

/** Starts the recognizer and reports its text. A test passes its own, so no device is needed. */
fun interface VoiceLauncher {
  fun launch(onResult: (String) -> Unit)
}

/** The microphone of the search row. */
val MicIcon: ImageVector = outlineIcon("Mic") {
  moveTo(9.5f, 5.5f)
  arcTo(2.5f, 2.5f, 0f, isMoreThanHalf = true, isPositiveArc = true, x1 = 14.5f, y1 = 5.5f)
  lineTo(14.5f, 11f)
  arcTo(2.5f, 2.5f, 0f, isMoreThanHalf = true, isPositiveArc = true, x1 = 9.5f, y1 = 11f)
  close()
  moveTo(6f, 10f)
  lineTo(6f, 11f)
  arcTo(6f, 6f, 0f, isMoreThanHalf = true, isPositiveArc = false, x1 = 18f, y1 = 11f)
  lineTo(18f, 10f)
  moveTo(12f, 17f)
  lineTo(12f, 20f)
  moveTo(9f, 20f)
  lineTo(15f, 20f)
}

/** The reset beside the microphone: an arrow turning back on itself. */
val ResetIcon: ImageVector = outlineIcon("Reset") {
  moveTo(3f, 12f)
  arcTo(9f, 9f, 0f, isMoreThanHalf = true, isPositiveArc = false, x1 = 12f, y1 = 3f)
  arcTo(9.75f, 9.75f, 0f, isMoreThanHalf = false, isPositiveArc = false, x1 = 5.26f, y1 = 5.74f)
  lineTo(3f, 8f)
  moveTo(3f, 3f)
  lineTo(3f, 8f)
  lineTo(8f, 8f)
}

/** Whether this device answers [RecognizerIntent]: with no recognizer, no mic button and no mic
 *  key. Android 11 up hides another package's activities until the manifest asks for them. */
@Composable
fun voiceSearchAvailable(): Boolean {
  val context = LocalContext.current
  return remember(context) { context.packageManager.resolveActivity(recognizerIntent(context), 0) != null }
}

/** Free-form speech, one answer, and the interface's own language -- AppCompat has already applied
 *  the account's chosen one to these resources. */
fun recognizerIntent(context: Context): Intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
  putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
  putExtra(RecognizerIntent.EXTRA_LANGUAGE, context.resources.configuration.locales[0].toLanguageTag())
  putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
}

/**
 * The recognizer behind one seam: [voiceAvailable] is the device check and [onVoiceResult] receives
 * what was heard. [launcher] is the platform intent unless a test answers instead; a cancelled,
 * blank or failed answer reaches nobody.
 */
@Composable
fun rememberVoiceSearch(
  voiceAvailable: Boolean,
  onVoiceResult: (String) -> Unit,
  launcher: VoiceLauncher? = null,
): VoiceSearch {
  val context = LocalContext.current
  val answer = rememberUpdatedState(onVoiceResult)
  val activity = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
    if (result.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult
    val spoken = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
    if (!spoken.isNullOrBlank()) answer.value(spoken)
  }
  val intent = remember(context) { recognizerIntent(context) }
  return VoiceSearch(voiceAvailable) {
    if (launcher != null) {
      launcher.launch { answer.value(it) }
    } else {
      runCatching { activity.launch(intent) }
    }
  }
}

/** The remote's mic key while Search is on screen; with no recognizer the key is left to the system. */
fun Modifier.voiceKey(voice: VoiceSearch): Modifier = onPreviewKeyEvent { event ->
  val mic = event.key == Key.Search || event.key == Key.VoiceAssist || event.key == Key.Assist
  if (!voice.available || !mic || event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
  voice.start()
  true
}
