package cz.stremiooffline.tv.ui.profiles

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Glow
import androidx.tv.material3.Icon
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.focusGroup
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.ProfileDto
import cz.stremiooffline.tv.ui.components.outlineIcon
import cz.stremiooffline.tv.ui.theme.Tokens
import cz.stremiooffline.tv.ui.theme.appBackground

const val TagProfileSwitcher = "profile_switcher"
const val TagPinPad = "pin_pad"
const val TagPinDots = "pin_dots"
const val TagPinUsePassword = "pin_use_password"
const val TagProfilePassword = "profile_password"
const val TagProfileSubmit = "profile_submit"
const val TagProfileError = "profile_error"
const val TagProfilesRetry = "profiles_retry"

fun profileTag(id: String): String = "profile_$id"

fun pinKeyTag(key: String): String = "pin_key_$key"

@Composable
fun ProfileSwitcherScreen(
  viewModel: ProfileSwitcherViewModel,
  onClose: () -> Unit,
) {
  BackHandler {
    if (viewModel.step is SwitcherStep.Choose || viewModel.step is SwitcherStep.Busy) onClose()
    else viewModel.back()
  }
  val errorText = switcherErrorText(viewModel.error, viewModel.waitSeconds)
  Box(
    Modifier
      .fillMaxSize()
      .appBackground()
      .testTag(TagProfileSwitcher)
      .focusGroup(),
    contentAlignment = Alignment.Center,
  ) {
    when (val step = viewModel.step) {
      SwitcherStep.Choose -> ChooseStep(
        profiles = viewModel.profiles,
        failure = viewModel.loadFailure,
        onChoose = viewModel::choose,
        onRetry = viewModel::load,
      )
      is SwitcherStep.Pin -> PinPad(
        profile = step.profile,
        pin = viewModel.pin,
        error = errorText,
        confirmEnabled = viewModel.waitSeconds == 0,
        onDigit = viewModel::appendDigit,
        onDelete = viewModel::deleteDigit,
        onConfirm = viewModel::submitPin,
        onUsePassword = viewModel::usePassword,
      )
      is SwitcherStep.Password -> ProfilePasswordStep(
        profile = step.profile,
        password = viewModel.password,
        onPasswordChange = viewModel::onPasswordChange,
        lockedHint = step.lockedHint,
        error = errorText,
        confirmEnabled = viewModel.waitSeconds == 0,
        onSubmit = viewModel::submitPassword,
      )
      SwitcherStep.Busy -> Text(
        stringResource(R.string.common_loading),
        color = Tokens.Muted,
        fontSize = 16.sp,
      )
    }
  }
}

@Composable
private fun switcherErrorText(error: SwitcherError?, waitSeconds: Int): String? {
  if (error == null) return null
  if (error.messageRes == R.string.err_too_many_attempts) {
    return stringResource(R.string.err_too_many_attempts, (if (waitSeconds > 0) waitSeconds else error.arg?.toIntOrNull() ?: 0).toString())
  }
  return error.arg?.let { stringResource(error.messageRes, it) } ?: stringResource(error.messageRes)
}

@Composable
private fun ChooseStep(profiles: List<ProfileDto>, failure: ApiFailure?, onChoose: (ProfileDto) -> Unit, onRetry: () -> Unit) {
  val firstFocus = remember { FocusRequester() }
  val retryFocus = remember { FocusRequester() }
  LaunchedEffect(failure) {
    if (failure != null) runCatching { retryFocus.requestFocus() }
  }
  val firstSelectable = profiles.indexOfFirst { !it.current }
  LaunchedEffect(firstSelectable) {
    if (firstSelectable >= 0) runCatching { firstFocus.requestFocus() }
  }
  Column(
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(28.dp),
  ) {
    Text(
      stringResource(R.string.profiles_switch),
      color = Tokens.Text,
      fontSize = 32.sp,
      fontWeight = FontWeight.ExtraBold,
      letterSpacing = (-0.8).sp,
    )
    if (failure != null) {
      Text(
        stringResource(if (failure == ApiFailure.Unreachable) R.string.tv_err_unreachable else R.string.tv_err_generic),
        color = Tokens.Red,
        fontSize = 16.sp,
        modifier = Modifier.testTag(TagProfileError),
      )
      FocusButton(
        text = stringResource(R.string.common_retry),
        onClick = onRetry,
        modifier = Modifier.focusRequester(retryFocus).testTag(TagProfilesRetry),
      )
    }
    Row(
      modifier = Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 24.dp).focusGroup(),
      horizontalArrangement = Arrangement.spacedBy(28.dp),
      verticalAlignment = Alignment.Top,
    ) {
      profiles.forEachIndexed { index, profile ->
        ProfileAvatar(
          profile = profile,
          onClick = { onChoose(profile) },
          modifier = if (index == firstSelectable) Modifier.focusRequester(firstFocus) else Modifier,
        )
      }
    }
  }
}

@Composable
internal fun ProfileAvatar(
  profile: ProfileDto,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  size: Int = 100,
  interactive: Boolean = true,
) {
  val initial = profile.username.take(1).uppercase()
  Column(
    modifier = Modifier.then(if (profile.current) Modifier.alpha(0.45f) else Modifier),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    val face = @Composable {
      Box(
        Modifier
          .size(size.dp)
          .background(profileAvatarBrush(profile.id), CircleShape),
        contentAlignment = Alignment.Center,
      ) {
        Text(initial, color = Color.White, fontSize = (size / 2.4).sp, fontWeight = FontWeight.ExtraBold)
      }
    }
    if (!interactive || profile.current) {
      Box(Modifier.testTag(profileTag(profile.id)).focusProperties { canFocus = false }) { face() }
    } else {
      val shape = CircleShape
      Surface(
        onClick = onClick,
        modifier = modifier.size(size.dp).testTag(profileTag(profile.id)),
        shape = ClickableSurfaceDefaults.shape(shape = shape),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.08f),
        glow = ClickableSurfaceDefaults.glow(focusedGlow = Glow(Tokens.Accent2.copy(alpha = 0.35f), 18.dp)),
        border = ClickableSurfaceDefaults.border(
          border = Border.None,
          focusedBorder = Border(BorderStroke(2.dp, Tokens.Accent2), shape = shape),
        ),
        colors = ClickableSurfaceDefaults.colors(
          containerColor = Color.Transparent,
          focusedContainerColor = Color.Transparent,
        ),
      ) { face() }
    }
    Text(profile.username, color = Tokens.Text, fontSize = 15.sp, fontWeight = FontWeight.Bold)
    when {
      profile.current -> Text(
        stringResource(R.string.profiles_current),
        color = Tokens.Green,
        fontSize = 11.sp,
      )
      profile.unlock == "pin" -> ProfileBadge(ProfileLockIcon, stringResource(R.string.profiles_needs_pin))
      profile.unlock == "password" -> ProfileBadge(ProfileKeyIcon, stringResource(R.string.profiles_needs_password))
      else -> Box(Modifier.size(14.dp))
    }
  }
}

@Composable
private fun ProfileBadge(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String) {
  Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
    Icon(icon, contentDescription = label, tint = Tokens.Muted, modifier = Modifier.size(14.dp))
  }
}

internal fun profileAvatarBrush(seed: String): Brush {
  val tones = listOf(
    listOf(Tokens.Accent, Tokens.Plum),
    listOf(Color(0xFF3A8F7A), Color(0xFF235A8C)),
    listOf(Color(0xFFB98A2E), Color(0xFFA84F2C)),
    listOf(Color(0xFF6A5ACD), Tokens.Plum),
  )
  val pair = tones[(seed.hashCode() ushr 1) % tones.size]
  return Brush.linearGradient(pair)
}

internal val ProfileLockIcon = outlineIcon("ProfileLock") {
  moveTo(4f, 11f)
  lineTo(20f, 11f)
  lineTo(20f, 21f)
  lineTo(4f, 21f)
  close()
  moveTo(8f, 11f)
  lineTo(8f, 7f)
  arcTo(4f, 4f, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = 16f, y1 = 7f)
  lineTo(16f, 11f)
}

internal val ProfileKeyIcon = outlineIcon("ProfileKey") {
  moveTo(4f, 15f)
  arcTo(4f, 4f, 0f, isMoreThanHalf = true, isPositiveArc = true, x1 = 12f, y1 = 15f)
  arcTo(4f, 4f, 0f, isMoreThanHalf = true, isPositiveArc = true, x1 = 4f, y1 = 15f)
  moveTo(10.8f, 12.2f)
  lineTo(20f, 3f)
  moveTo(16f, 7f)
  lineTo(19f, 10f)
}
