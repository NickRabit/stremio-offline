package cz.stremiooffline.tv.ui.profiles

import android.view.KeyEvent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.ProfileDto
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.theme.Tokens

private val PadKeys = listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "delete", "0", "confirm")

@Composable
fun PinPad(
  profile: ProfileDto,
  pin: String,
  error: String?,
  confirmEnabled: Boolean,
  onDigit: (Char) -> Unit,
  onDelete: () -> Unit,
  onConfirm: () -> Unit,
  onUsePassword: () -> Unit,
) {
  val fiveFocus = remember { FocusRequester() }
  LaunchedEffect(Unit) { runCatching { fiveFocus.requestFocus() } }
  Row(
    modifier = Modifier
      .testTag(TagPinPad)
      .onPreviewKeyEvent { event ->
        val code = event.nativeKeyEvent.keyCode
        val mapped = when (code) {
          in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> {
            if (event.type == KeyEventType.KeyDown) onDigit('0' + (code - KeyEvent.KEYCODE_0))
            true
          }
          in KeyEvent.KEYCODE_NUMPAD_0..KeyEvent.KEYCODE_NUMPAD_9 -> {
            if (event.type == KeyEventType.KeyDown) onDigit('0' + (code - KeyEvent.KEYCODE_NUMPAD_0))
            true
          }
          KeyEvent.KEYCODE_DEL -> {
            if (event.type == KeyEventType.KeyDown) onDelete()
            true
          }
          KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
            if (event.type == KeyEventType.KeyDown && confirmEnabled) onConfirm()
            true
          }
          else -> false
        }
        mapped
      }
      .focusGroup()
      .padding(horizontal = 48.dp),
    horizontalArrangement = Arrangement.spacedBy(60.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Column(
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
      ProfileAvatar(profile = profile, onClick = {}, size = 110, interactive = false)
      Text(
        stringResource(R.string.profiles_pin_for, profile.username),
        color = Tokens.Muted,
        fontSize = 14.sp,
      )
      Row(
        modifier = Modifier.testTag(TagPinDots).height(20.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        repeat(pin.length) {
          Box(Modifier.size(14.dp).background(Tokens.Text, CircleShape).border(1.5.dp, Tokens.Text, CircleShape))
        }
      }
      Text(
        error.orEmpty(),
        color = Tokens.Red,
        fontSize = 13.sp,
        modifier = Modifier.testTag(TagProfileError),
      )
    }
    Column(
      modifier = Modifier.focusGroup(),
      verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
      PadKeys.chunked(3).forEach { row ->
        Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
          row.forEach { key ->
            val label = when (key) {
              "delete" -> stringResource(R.string.profiles_pin_delete)
              "confirm" -> stringResource(R.string.profiles_pin_confirm)
              else -> key
            }
            val onClick: () -> Unit = when (key) {
              "delete" -> onDelete
              "confirm" -> onConfirm
              else -> ({ onDigit(key[0]) })
            }
            FocusButton(
              text = label,
              onClick = onClick,
              enabled = key != "confirm" || confirmEnabled,
              kind = if (key == "confirm") FocusButtonKind.Primary else FocusButtonKind.Normal,
              height = 52.dp,
              modifier = Modifier
                .width(64.dp)
                .testTag(pinKeyTag(key))
                .then(if (key == "5") Modifier.focusRequester(fiveFocus) else Modifier),
            )
          }
        }
      }
      FocusButton(
        text = stringResource(R.string.profiles_use_password),
        onClick = onUsePassword,
        leading = {
          Icon(ProfileKeyIcon, contentDescription = null, modifier = Modifier.size(16.dp))
        },
        modifier = Modifier.width(210.dp).testTag(TagPinUsePassword),
      )
    }
  }
}
