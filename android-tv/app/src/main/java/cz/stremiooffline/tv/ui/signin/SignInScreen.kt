package cz.stremiooffline.tv.ui.signin

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.ui.components.BrandMark
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.theme.Tokens
import cz.stremiooffline.tv.ui.theme.appBackground

private const val DefaultAddress = "http://"

/**
 * @param prefillAddress the address the sign-in screen was opened with. It decides the initial
 *   focus: a bare `http://` sends focus to the address field, a real address to Sign in.
 */
@Composable
fun SignInScreen(viewModel: SignInViewModel, prefillAddress: String, modifier: Modifier = Modifier) {
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
      Field(
        label = stringResource(R.string.tv_server_address),
        value = state.server,
        onValueChange = viewModel::onServerChange,
        keyboardType = KeyboardType.Uri,
        surfaceRequester = addressFocus,
        onFocusLost = viewModel::checkServer,
      ) { ServerStatusLine(state.check) }
      Field(
        label = stringResource(R.string.auth_username),
        value = state.username,
        onValueChange = viewModel::onUsernameChange,
      )
      Field(
        label = stringResource(R.string.auth_password),
        value = state.password,
        onValueChange = viewModel::onPasswordChange,
        password = true,
        imeAction = ImeAction.Done,
      )
      FocusButton(
        text = stringResource(R.string.auth_sign_in),
        onClick = viewModel::signIn,
        modifier = Modifier.focusRequester(signInFocus),
        kind = FocusButtonKind.Primary,
      )
      val error = state.error
      if (error != null) {
        Text(
          if (error == ApiFailure.TooMany) stringResource(R.string.tv_err_too_many, state.errorSeconds ?: 0)
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

/**
 * A field is a focusable surface first: D-pad focus only draws the border. Editing starts on
 * ENTER/CENTER, and the IME action or Back leaves it while the focus stays where it belongs.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Field(
  label: String,
  value: String,
  onValueChange: (String) -> Unit,
  modifier: Modifier = Modifier,
  password: Boolean = false,
  keyboardType: KeyboardType = KeyboardType.Text,
  imeAction: ImeAction = ImeAction.Next,
  surfaceRequester: FocusRequester? = null,
  onFocusLost: () -> Unit = {},
  below: (@Composable () -> Unit)? = null,
) {
  var surfaceFocused by remember { mutableStateOf(false) }
  var editing by remember { mutableStateOf(false) }
  val ownSurface = remember { FocusRequester() }
  val surface = surfaceRequester ?: ownSurface
  val input = remember { FocusRequester() }
  val focusManager = LocalFocusManager.current
  val keyboard = LocalSoftwareKeyboardController.current
  val shape = RoundedCornerShape(7.dp)
  val active = surfaceFocused || editing

  fun stopEditing(move: FocusDirection?) {
    editing = false
    keyboard?.hide()
    if (move == null) surface.requestFocus() else focusManager.moveFocus(move)
  }

  var wasActive by remember { mutableStateOf(false) }
  LaunchedEffect(active) {
    if (wasActive && !active) onFocusLost()
    wasActive = active
  }
  LaunchedEffect(editing) {
    if (editing) {
      input.requestFocus()
      keyboard?.show()
    }
  }
  // A remote Back is consumed by the IME before it reaches the app, so the field also leaves the
  // editing state when the IME disappears on its own.
  val imeVisible = WindowInsets.isImeVisible
  var imeWasVisible by remember { mutableStateOf(false) }
  LaunchedEffect(imeVisible) {
    if (imeVisible) {
      imeWasVisible = true
    } else {
      if (imeWasVisible && editing) stopEditing(null)
      imeWasVisible = false
    }
  }

  Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
    Text(
      label.uppercase(),
      color = Tokens.Muted,
      fontSize = 8.5.sp,
      fontWeight = FontWeight.ExtraBold,
      letterSpacing = 0.8.sp,
    )
    Box(
      modifier = Modifier
        .fillMaxWidth()
        .height(38.dp)
        .focusRequester(surface)
        .onPreviewKeyEvent { event ->
          val enter = event.key == Key.DirectionCenter || event.key == Key.Enter
          if (enter && event.type == KeyEventType.KeyDown && !editing) {
            editing = true
            true
          } else {
            false
          }
        }
        .focusable()
        .onFocusChanged { surfaceFocused = it.isFocused }
        .background(Tokens.Bg, shape)
        .border(if (active) 2.dp else 1.dp, if (active) Tokens.Accent2 else Tokens.Line, shape)
        .padding(horizontal = 12.dp),
      contentAlignment = Alignment.CenterStart,
    ) {
      BasicTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = true,
        textStyle = TextStyle(color = Tokens.Text, fontSize = 13.sp),
        cursorBrush = SolidColor(Tokens.Accent2),
        visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType, imeAction = imeAction),
        keyboardActions = KeyboardActions(
          onNext = { stopEditing(FocusDirection.Down) },
          onDone = { stopEditing(FocusDirection.Down) },
        ),
        modifier = Modifier
          .fillMaxWidth()
          .focusRequester(input)
          .focusProperties { canFocus = editing }
          .onPreviewKeyEvent { event ->
            if (event.type != KeyEventType.KeyDown) {
              false
            } else {
              when (event.key) {
                // TV keyboards often have no Next key, so Down ends editing just as well.
                Key.DirectionDown -> {
                  stopEditing(FocusDirection.Down)
                  true
                }
                Key.Back -> {
                  stopEditing(null)
                  true
                }
                else -> false
              }
            }
          },
      )
    }
    below?.invoke()
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
