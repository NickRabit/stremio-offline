package cz.stremiooffline.tv.ui.profiles

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import cz.stremiooffline.tv.data.AvatarDto
import cz.stremiooffline.tv.ui.sessionImageLoader
import cz.stremiooffline.tv.ui.theme.Tokens

internal val LocalProfileServer = staticCompositionLocalOf { "" }

@Composable
fun ProfileFace(
  name: String,
  seed: String,
  avatar: AvatarDto?,
  size: Dp,
  modifier: Modifier = Modifier,
) {
  val model = avatarModel(avatar, LocalProfileServer.current)
  var loaded by remember(model) { mutableStateOf(false) }
  var failed by remember(model) { mutableStateOf(false) }
  val preset = avatar?.kind == "preset"
  Box(
    modifier
      .size(size)
      .clip(CircleShape)
      .then(
        if (preset && loaded) Modifier.background(Tokens.Panel2)
        else Modifier.background(profileAvatarBrush(seed)),
      ),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      name.take(1).uppercase(),
      color = Color.White,
      fontSize = (size.value / 2.4f).sp,
      fontWeight = FontWeight.ExtraBold,
    )
    if (model != null && !failed) {
      AsyncImage(
        model = model,
        contentDescription = null,
        imageLoader = sessionImageLoader(),
        contentScale = if (preset) ContentScale.Fit else ContentScale.Crop,
        onLoading = { loaded = false },
        onSuccess = { loaded = true },
        onError = {
          loaded = false
          failed = true
        },
        modifier = if (preset) Modifier.size(size * 0.72f) else Modifier.fillMaxSize(),
      )
    }
  }
}

internal fun avatarModel(avatar: AvatarDto?, server: String): String? {
  val base = server.trim().trimEnd('/')
  if (base.isBlank()) return null
  return when (avatar?.kind) {
    "preset" -> avatar.id?.takeIf { it.isNotBlank() }?.let { "$base/avatars/$it.svg" }
    "custom" -> avatar.url?.takeIf { it.isNotBlank() }?.let { url ->
      if (url.startsWith("http://") || url.startsWith("https://")) url
      else "$base/${url.trimStart('/')}"
    }
    else -> null
  }
}
