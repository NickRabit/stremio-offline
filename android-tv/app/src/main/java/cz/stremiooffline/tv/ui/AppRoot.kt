package cz.stremiooffline.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.ApiClient
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.CookieStore
import cz.stremiooffline.tv.data.MeResult
import cz.stremiooffline.tv.data.ServerAddress
import cz.stremiooffline.tv.data.SessionStore
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.shell.Section
import cz.stremiooffline.tv.ui.shell.Shell
import cz.stremiooffline.tv.ui.shell.startSection
import cz.stremiooffline.tv.ui.signin.SignInScreen
import cz.stremiooffline.tv.ui.signin.SignInViewModel
import cz.stremiooffline.tv.ui.theme.Tokens
import cz.stremiooffline.tv.ui.theme.appBackground
import kotlinx.coroutines.launch

sealed interface SessionState {
  data object Loading : SessionState
  data class SignedOut(val address: String, val error: ApiFailure?) : SessionState
  data class SignedIn(val username: String, val start: Section) : SessionState
  data class Offline(val server: String) : SessionState
}

class SessionViewModel(private val store: SessionStore) : ViewModel() {

  var state by mutableStateOf<SessionState>(SessionState.Loading)
    private set

  init {
    restore()
  }

  /** Reads the stored session and asks the server who it belongs to. */
  fun restore() {
    val address = store.serverUrl?.let(ServerAddress::parse)
    if (address == null) {
      state = SessionState.SignedOut(store.serverUrl ?: DEFAULT_ADDRESS, null)
      return
    }
    // A server with no session left is not an expired one: someone signed out on purpose.
    if (store.loadSession(address.origin) == null) {
      state = SessionState.SignedOut(address.display, null)
      return
    }
    viewModelScope.launch {
      state = SessionState.Loading
      val api = ApiClient(address, CookieStore(address.origin, store))
      try {
        state = when (val me = api.me()) {
          is MeResult.SignedIn -> SessionState.SignedIn(me.username, startSection(settingsOf(api)))
          MeResult.Setup -> {
            store.clearSession()
            SessionState.SignedOut(address.display, ApiFailure.NeedsSetup)
          }
        }
      } catch (error: ApiError) {
        if (error.failure == ApiFailure.Unreachable) {
          state = SessionState.Offline(address.display)
        } else {
          store.clearSession()
          state = SessionState.SignedOut(address.display, error.failure)
        }
      }
    }
  }

  fun signedIn(username: String, start: Section) {
    state = SessionState.SignedIn(username, start)
  }

  fun changeServer() {
    state = SessionState.SignedOut(store.serverUrl ?: DEFAULT_ADDRESS, null)
  }

  fun signOut() {
    val address = store.serverUrl?.let(ServerAddress::parse)
    viewModelScope.launch {
      if (address != null) ApiClient(address, CookieStore(address.origin, store)).logout()
      store.clearSession()
      state = SessionState.SignedOut(address?.display ?: DEFAULT_ADDRESS, null)
    }
  }

  private suspend fun settingsOf(api: ApiClient): String? =
    try {
      api.settings().startView
    } catch (_: ApiError) {
      null
    }

  companion object {
    const val DEFAULT_ADDRESS = "http://"

    fun factory(store: SessionStore) = viewModelFactory { initializer { SessionViewModel(store) } }
  }
}

@Composable
fun AppRoot() {
  val context = LocalContext.current
  val store = remember { SessionStore(context.applicationContext) }
  val session = viewModel<SessionViewModel>(factory = SessionViewModel.factory(store))

  when (val state = session.state) {
    SessionState.Loading -> Box(Modifier.fillMaxSize().appBackground())

    is SessionState.SignedOut -> {
      val signIn = viewModel<SignInViewModel>(factory = SignInViewModel.factory(store, session::signedIn))
      LaunchedEffect(state.address, state.error) { signIn.reset(state.address, state.error) }
      SignInScreen(signIn, prefillAddress = state.address)
    }

    is SessionState.SignedIn -> Shell(
      username = state.username,
      start = state.start,
      onSignOut = session::signOut,
    )

    is SessionState.Offline -> OfflinePanel(
      server = state.server,
      onRetry = session::restore,
      onChangeServer = session::changeServer,
    )
  }
}

@Composable
private fun OfflinePanel(server: String, onRetry: () -> Unit, onChangeServer: () -> Unit) {
  val shape = RoundedCornerShape(12.dp)
  Box(Modifier.fillMaxSize().appBackground(), contentAlignment = Alignment.Center) {
    Column(
      modifier = Modifier
        .width(410.dp)
        .background(Brush.verticalGradient(listOf(Tokens.Panel, Color(0xFF11161E))), shape)
        .border(1.dp, Tokens.Line, shape)
        .padding(horizontal = 32.dp, vertical = 28.dp),
      verticalArrangement = Arrangement.spacedBy(11.dp),
    ) {
      Box(
        modifier = Modifier.size(48.dp).background(Tokens.Red.copy(alpha = 0.12f), RoundedCornerShape(12.dp)),
        contentAlignment = Alignment.Center,
      ) {
        Icon(OfflineIcon, contentDescription = null, tint = Tokens.Red, modifier = Modifier.size(24.dp))
      }
      Text(
        stringResource(R.string.tv_offline_title),
        color = Tokens.Text,
        fontSize = 23.sp,
        fontWeight = FontWeight.ExtraBold,
        letterSpacing = (-0.6).sp,
      )
      Text(
        stringResource(R.string.tv_offline_text, server),
        color = Tokens.Muted,
        fontSize = 11.5.sp,
        lineHeight = 17.sp,
      )
      Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
        FocusButton(stringResource(R.string.tv_try_again), onClick = onRetry, kind = FocusButtonKind.Primary)
        FocusButton(stringResource(R.string.tv_change_server), onClick = onChangeServer)
      }
    }
  }
}

private val OfflineIcon: ImageVector = ImageVector.Builder(
  name = "Offline",
  defaultWidth = 24.dp,
  defaultHeight = 24.dp,
  viewportWidth = 24f,
  viewportHeight = 24f,
).apply {
  path(
    stroke = SolidColor(Color.White),
    strokeLineWidth = 2f,
    strokeLineCap = StrokeCap.Round,
    strokeLineJoin = StrokeJoin.Round,
  ) {
    moveTo(2f, 8.8f)
    arcTo(15f, 15f, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = 6.2f, y1 = 6.2f)
    moveTo(10.7f, 5.1f)
    arcTo(15f, 15f, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = 22f, y1 = 8.8f)
    moveTo(5f, 12.5f)
    arcTo(10f, 10f, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = 8.4f, y1 = 10.5f)
    moveTo(15.5f, 10.6f)
    arcTo(10f, 10f, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = 19f, y1 = 12.5f)
    moveTo(8.5f, 16f)
    arcTo(5f, 5f, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = 15.5f, y1 = 16f)
    moveTo(12f, 20f)
    lineTo(12.01f, 20f)
    moveTo(3f, 3f)
    lineTo(21f, 21f)
  }
}.build()
