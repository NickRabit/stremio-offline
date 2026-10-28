package cz.stremiooffline.tv.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.ui.components.BrandMark
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.theme.Tokens
import cz.stremiooffline.tv.ui.theme.appBackground
import kotlinx.coroutines.android.awaitFrame

const val TagLocalNetworkAllow = "local_network_allow"
const val TagLocalNetworkSettings = "local_network_settings"

private const val Android17 = 37

@Composable
fun LocalNetworkAccessGate(content: @Composable () -> Unit) {
  val context = LocalContext.current
  val lifecycleOwner = LocalLifecycleOwner.current
  var granted by remember { mutableStateOf(hasLocalNetworkAccess(context)) }
  var denied by remember { mutableStateOf(false) }
  val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
    granted = allowed
    denied = !allowed
  }
  DisposableEffect(lifecycleOwner, context) {
    val observer = LifecycleEventObserver { _, event ->
      if (event == Lifecycle.Event.ON_RESUME) {
        val allowed = hasLocalNetworkAccess(context)
        granted = allowed
        if (allowed) denied = false
      }
    }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
  }

  fun allow() {
    if (hasLocalNetworkAccess(context)) {
      granted = true
      denied = false
    } else {
      launcher.launch(Manifest.permission.ACCESS_LOCAL_NETWORK)
    }
  }

  if (granted) {
    content()
  } else {
    LocalNetworkPermissionScreen(
      denied = denied,
      onAllow = ::allow,
      onSettings = {
        context.startActivity(
          Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.parse("package:${context.packageName}")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          },
        )
      },
    )
  }
}

@Composable
internal fun LocalNetworkPermissionScreen(denied: Boolean, onAllow: () -> Unit, onSettings: () -> Unit) {
  val allowFocus = remember { FocusRequester() }
  val shape = RoundedCornerShape(14.dp)
  LaunchedEffect(Unit) {
    awaitFrame()
    runCatching { allowFocus.requestFocus() }
  }
  Box(Modifier.fillMaxSize().appBackground(), contentAlignment = Alignment.Center) {
    Column(
      modifier = Modifier
        .width(470.dp)
        .background(Brush.verticalGradient(listOf(Tokens.Panel, Tokens.Panel2)), shape)
        .border(1.dp, Tokens.Line, shape)
        .padding(horizontal = 32.dp, vertical = 28.dp),
      verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
      BrandMark(dimension = 38.dp, corner = 10.dp)
      Text(
        stringResource(R.string.tv_local_network_title),
        color = Tokens.Text,
        fontSize = 23.sp,
      )
      Text(stringResource(R.string.tv_local_network_text), color = Tokens.Muted, fontSize = 12.sp, lineHeight = 18.sp)
      if (denied) {
        Text(stringResource(R.string.tv_local_network_denied), color = Tokens.Red, fontSize = 11.sp, lineHeight = 17.sp)
      }
      FocusButton(
        text = stringResource(R.string.tv_local_network_allow),
        onClick = onAllow,
        modifier = Modifier.focusRequester(allowFocus).testTag(TagLocalNetworkAllow),
        kind = FocusButtonKind.Primary,
      )
      FocusButton(
        text = stringResource(R.string.nav_settings),
        onClick = onSettings,
        modifier = Modifier.testTag(TagLocalNetworkSettings),
      )
    }
  }
}

internal fun localNetworkAccessGranted(sdkInt: Int, permission: () -> Int): Boolean =
  sdkInt < Android17 || permission() == PackageManager.PERMISSION_GRANTED

fun hasLocalNetworkAccess(context: Context): Boolean =
  localNetworkAccessGranted(Build.VERSION.SDK_INT) {
    ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_LOCAL_NETWORK)
  }
