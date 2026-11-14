package cz.stremiooffline.tv.ui.profiles

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.ProfileDto
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.TvTextField
import cz.stremiooffline.tv.ui.theme.Tokens

@Composable
fun ProfilePasswordStep(
  profile: ProfileDto,
  password: String,
  onPasswordChange: (String) -> Unit,
  lockedHint: Boolean,
  error: String?,
  confirmEnabled: Boolean,
  onSubmit: () -> Unit,
) {
  val fieldFocus = remember { FocusRequester() }
  LaunchedEffect(Unit) { runCatching { fieldFocus.requestFocus() } }
  Column(
    modifier = Modifier.width(360.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    ProfileAvatar(profile = profile, onClick = {}, size = 96, interactive = false)
    Text(
      stringResource(R.string.profiles_password_for, profile.username),
      color = Tokens.Muted,
      fontSize = 14.sp,
    )
    if (lockedHint) {
      Text(
        stringResource(R.string.profiles_pin_locked),
        color = Tokens.Muted,
        fontSize = 13.sp,
        modifier = Modifier.testTag("profile_locked_hint"),
      )
    }
    TvTextField(
      label = stringResource(R.string.auth_password),
      value = password,
      onValueChange = onPasswordChange,
      password = true,
      keyboardType = KeyboardType.Password,
      imeAction = ImeAction.Done,
      surfaceRequester = fieldFocus,
      testTag = TagProfilePassword,
      enabled = confirmEnabled,
      onSubmit = onSubmit,
    )
    if (!error.isNullOrEmpty()) {
      Text(error, color = Tokens.Red, fontSize = 13.sp, modifier = Modifier.testTag(TagProfileError))
    }
    FocusButton(
      text = stringResource(R.string.profiles_submit),
      onClick = onSubmit,
      enabled = confirmEnabled,
      kind = FocusButtonKind.Primary,
      modifier = Modifier.testTag(TagProfileSubmit),
    )
  }
}
