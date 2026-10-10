package cz.stremiooffline.tv.ui.signin

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.ui.components.BrandMark
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.TvTextField
import cz.stremiooffline.tv.ui.theme.Tokens
import cz.stremiooffline.tv.ui.theme.appBackground

private const val DefaultAddress = "http://"

const val TagAddress = "signin_address"
const val TagUsername = "signin_username"
const val TagPassword = "signin_password"
const val TagSignIn = "signin_submit"

/**
 * @param prefillAddress the address the sign-in screen was opened with. It decides the initial
 *   focus: a bare `http://` sends focus to the address field, a real address to Sign in.
 */
@Composable
fun SignInScreen(viewModel: SignInActions, prefillAddress: String, modifier: Modifier = Modifier) {
  val state = viewModel.state
  val shape = RoundedCornerShape(12.dp)
  val addressFocus = remember { FocusRequester() }
  val signInFocus = remember { FocusRequester() }

  LaunchedEffect(Unit) {
    if (prefillAddress == DefaultAddress) addressFocus.requestFocus() else signInFocus.requestFocus()
  }

  Box(modifier.fillMaxSize().appBackground(), contentAlignment = Alignment.Center) {
    Column(
      modifier = Modifier
        .width(410.dp)
        .background(Brush.verticalGradient(listOf(Tokens.Panel, Color(0xFF11161E))), shape)
        .border(1.dp, Tokens.Line, shape)
        .padding(horizontal = 32.dp, vertical = 28.dp),
      verticalArrangement = Arrangement.spacedBy(11.dp),
    ) {
      BrandMark(dimension = 38.dp, corner = 10.dp)
      Text(
        stringResource(R.string.auth_brand_eyebrow),
        color = Tokens.Accent,
        fontSize = 8.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 1.5.sp,
      )
      Text(
        stringResource(R.string.tv_connect_title),
        color = Tokens.Text,
        fontSize = 23.sp,
        fontWeight = FontWeight.ExtraBold,
        letterSpacing = (-0.6).sp,
      )
      TvTextField(
        label = stringResource(R.string.tv_server_address),
        value = state.server,
        onValueChange = viewModel::onServerChange,
        keyboardType = KeyboardType.Uri,
        surfaceRequester = addressFocus,
        onFocusLost = viewModel::checkServer,
        testTag = TagAddress,
      ) { ServerStatusLine(state.check) }
      TvTextField(
        label = stringResource(R.string.auth_username),
        value = state.username,
        onValueChange = viewModel::onUsernameChange,
        testTag = TagUsername,
      )
      TvTextField(
        label = stringResource(R.string.auth_password),
        value = state.password,
        onValueChange = viewModel::onPasswordChange,
        password = true,
        imeAction = ImeAction.Done,
        testTag = TagPassword,
      )
      FocusButton(
        text = stringResource(R.string.auth_sign_in),
        onClick = viewModel::signIn,
        modifier = Modifier.focusRequester(signInFocus).testTag(TagSignIn),
        kind = FocusButtonKind.Primary,
      )
      val error = state.error
      if (error != null) {
        Text(
          if (error == ApiFailure.TooMany) stringResource(R.string.tv_err_too_many, (state.errorSeconds ?: 0).toString())
          else stringResource(error.messageRes()),
          color = Tokens.Red,
          fontSize = 10.sp,
        )
      }
      Text(
        stringResource(R.string.tv_signin_note),
        color = Tokens.Muted,
        fontSize = 9.5.sp,
        lineHeight = 14.sp,
      )
    }
  }
}

@Composable
private fun ServerStatusLine(check: ServerCheck) {
  when (check) {
    ServerCheck.Idle, ServerCheck.Checking -> Spacer(Modifier.height(13.dp))
    is ServerCheck.Found -> Row(
      modifier = Modifier.height(13.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      Box(Modifier.size(6.dp).clip(CircleShape).background(Tokens.Green))
      Text(stringResource(R.string.tv_server_found, check.version), color = Tokens.Muted, fontSize = 10.sp)
    }
    is ServerCheck.Failed -> Text(
      stringResource(check.failure.messageRes()),
      color = Tokens.Red,
      fontSize = 10.sp,
      lineHeight = 14.sp,
    )
  }
}
