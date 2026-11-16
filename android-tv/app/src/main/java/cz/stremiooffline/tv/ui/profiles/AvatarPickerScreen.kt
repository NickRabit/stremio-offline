package cz.stremiooffline.tv.ui.profiles

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Glow
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.AvatarDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.signin.messageRes
import cz.stremiooffline.tv.ui.theme.Tokens
import cz.stremiooffline.tv.ui.theme.appBackground
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.android.awaitFrame
import kotlinx.coroutines.launch

const val TagAvatarPicker = "avatar_picker"
const val TagAvatarInitial = "avatar_initial"
const val TagAvatarError = "avatar_error"

fun avatarPresetTag(id: String): String = "avatar_$id"

@Composable
fun AvatarPickerScreen(
  api: TvApi,
  name: String,
  seed: String,
  avatar: AvatarDto?,
  onChanged: (AvatarDto?) -> Unit,
  onClose: () -> Unit,
) {
  BackHandler(onBack = onClose)
  val scope = rememberCoroutineScope()
  val gridState = rememberLazyGridState()
  val initialFocus = remember { FocusRequester() }
  var presets by remember(api) { mutableStateOf(emptyList<String>()) }
  var failure by remember(api) { mutableStateOf<ApiFailure?>(null) }
  var busy by remember(api) { mutableStateOf(false) }
  val presetFocuses = remember { mutableMapOf<String, FocusRequester>() }
  val selected = avatar?.takeIf { it.kind == "preset" }?.id

  LaunchedEffect(api) {
    try {
      presets = api.avatarPresets()
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (error: ApiError) {
      failure = error.failure
    }
  }
  LaunchedEffect(presets, selected) {
    val index = presets.indexOf(selected)
    if (index >= 0) {
      gridState.scrollToItem(index)
      awaitFrame()
      presetFocuses[selected]?.let { runCatching { it.requestFocus() } }
    } else {
      runCatching { initialFocus.requestFocus() }
    }
  }

  fun save(preset: String?) {
    if (busy) return
    busy = true
    failure = null
    scope.launch {
      try {
        val next = api.setAvatar(preset)
        onChanged(next)
        onClose()
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        failure = error.failure
        busy = false
      }
    }
  }

  CompositionLocalProvider(LocalProfileServer provides api.serverAddress) {
    Column(
      modifier = Modifier
        .fillMaxSize()
        .appBackground()
        .padding(horizontal = Tokens.SafeX, vertical = Tokens.SafeY)
        .focusGroup()
        .testTag(TagAvatarPicker),
      verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(18.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        ProfileFace(name = name, seed = seed, avatar = avatar, size = 72.dp)
        Text(
          stringResource(R.string.avatar_pick),
          color = Tokens.Text,
          fontSize = 28.sp,
          fontWeight = FontWeight.ExtraBold,
        )
      }
      FocusButton(
        text = stringResource(R.string.avatar_use_initial),
        onClick = { save(null) },
        enabled = !busy,
        modifier = Modifier.focusRequester(initialFocus).testTag(TagAvatarInitial),
      )
      failure?.let {
        Text(
          stringResource(it.messageRes()),
          color = Tokens.Red,
          fontSize = 13.sp,
          modifier = Modifier.testTag(TagAvatarError),
        )
      }
      LazyVerticalGrid(
        columns = GridCells.Fixed(8),
        state = gridState,
        modifier = Modifier.fillMaxSize().focusGroup(),
        contentPadding = PaddingValues(horizontal = 6.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
      ) {
        items(presets, key = { it }) { id ->
          val focusRequester = remember(id) {
            FocusRequester().also { presetFocuses[id] = it }
          }
          AvatarPreset(
            id = id,
            name = name,
            focusRequester = focusRequester,
            selected = id == selected,
            onClick = { save(id) },
          )
        }
      }
    }
  }
}

@Composable
private fun AvatarPreset(
  id: String,
  name: String,
  focusRequester: FocusRequester,
  selected: Boolean,
  onClick: () -> Unit,
) {
  Surface(
    onClick = onClick,
    modifier = Modifier
      .size(96.dp)
      .focusRequester(focusRequester)
      .testTag(avatarPresetTag(id)),
    shape = ClickableSurfaceDefaults.shape(shape = CircleShape),
    scale = ClickableSurfaceDefaults.scale(focusedScale = 1.08f),
    glow = ClickableSurfaceDefaults.glow(focusedGlow = Glow(Tokens.Accent2.copy(alpha = 0.35f), 18.dp)),
    border = ClickableSurfaceDefaults.border(
      border = Border.None,
      focusedBorder = Border(BorderStroke(2.dp, Tokens.Accent2), shape = CircleShape),
    ),
    colors = ClickableSurfaceDefaults.colors(
      containerColor = if (selected) Tokens.Panel2 else Color.Transparent,
      focusedContainerColor = Color.Transparent,
      contentColor = Tokens.Text,
      focusedContentColor = Tokens.Text,
    ),
  ) {
    Box(Modifier.padding(2.dp)) {
      ProfileFace(
        name = name,
        seed = id,
        avatar = AvatarDto(kind = "preset", id = id),
        size = 96.dp,
      )
    }
  }
}
