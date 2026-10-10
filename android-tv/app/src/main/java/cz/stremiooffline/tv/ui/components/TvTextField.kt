package cz.stremiooffline.tv.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import cz.stremiooffline.tv.ui.theme.Tokens

/** Whether a field draws its accent border: focused by the D-pad or being edited. */
val TvFieldActive = SemanticsPropertyKey<Boolean>("TvFieldActive")

/**
 * The one text field of the app, shared by sign-in and search. It is a focusable surface first:
 * D-pad focus only draws the border. Editing starts on ENTER/CENTER, and the IME action (or the
 * IME going away) leaves editing while focus stays where it belongs. [onSubmit] is wired to the
 * IME Done; sign-in leaves it null and the action just moves focus down.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TvTextField(
  label: String,
  value: String,
  onValueChange: (String) -> Unit,
  modifier: Modifier = Modifier,
  password: Boolean = false,
  keyboardType: KeyboardType = KeyboardType.Text,
  imeAction: ImeAction = ImeAction.Next,
  surfaceRequester: FocusRequester? = null,
  onFocusLost: () -> Unit = {},
  testTag: String? = null,
  inputTestTag: String? = null,
  onSubmit: (() -> Unit)? = null,
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
  val imeVisible = androidx.compose.foundation.layout.WindowInsets.isImeVisible
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
        .then(if (testTag != null) Modifier.testTag(testTag) else Modifier)
        .onPreviewKeyEvent { event ->
          val enter = event.key == Key.DirectionCenter || event.key == Key.Enter
          if (enter && event.type == KeyEventType.KeyDown && !editing) {
            editing = true
            true
          } else {
            false
          }
        }
        // Observes the surface's own focus target, so it has to sit before `focusable()`.
        .onFocusChanged { surfaceFocused = it.isFocused }
        .focusable()
        .semantics { this[TvFieldActive] = active }
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
          onDone = {
            if (onSubmit == null) {
              stopEditing(FocusDirection.Down)
            } else {
              stopEditing(null)
              onSubmit()
            }
          },
        ),
        modifier = Modifier
          .fillMaxWidth()
          .focusRequester(input)
          .then(if (inputTestTag != null) Modifier.testTag(inputTestTag) else Modifier)
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
