package cz.stremiooffline.tv.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
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
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
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
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import coil3.ImageLoader
import coil3.annotation.ExperimentalCoilApi
import coil3.network.cachecontrol.CacheControlCacheStrategy
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import coil3.svg.SvgDecoder
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.ApiClient
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.AvatarDto
import cz.stremiooffline.tv.data.CookieStore
import cz.stremiooffline.tv.data.MeResult
import cz.stremiooffline.tv.data.ProfileApi
import cz.stremiooffline.tv.data.ServerAddress
import cz.stremiooffline.tv.data.SessionStore
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.detail.SpoilerSetting
import cz.stremiooffline.tv.ui.profiles.LocalProfileServer
import cz.stremiooffline.tv.ui.shell.Section
import cz.stremiooffline.tv.ui.shell.Shell
import cz.stremiooffline.tv.ui.shell.startSection
import cz.stremiooffline.tv.ui.signin.SignInScreen
import cz.stremiooffline.tv.ui.signin.SignInViewModel
import cz.stremiooffline.tv.ui.theme.Tokens
import cz.stremiooffline.tv.ui.theme.appBackground
import cz.stremiooffline.tv.watchnext.WatchNextPublisher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

sealed interface SessionState {
  data object Loading : SessionState
  data class SignedOut(val address: String, val error: ApiFailure?) : SessionState
  data class SignedIn(
    val username: String,
    val language: String?,
    val start: Section,
    val api: ApiClient,
    val canSwitch: Boolean = false,
    val child: Boolean = false,
    val catalogue: Boolean = false,
    val avatar: AvatarDto? = null,
  ) : SessionState
  data class Offline(val server: String) : SessionState
}

class SessionViewModel(
  private val store: SessionStore,
  private val appContext: Context? = null,
) : ViewModel() {

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
          is MeResult.SignedIn -> signedInState(me, api)
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

  fun signedIn(
    username: String,
    language: String?,
    start: Section,
    api: ApiClient,
    child: Boolean = false,
    catalogue: Boolean = false,
    avatar: AvatarDto? = null,
  ) {
    state = SessionState.SignedIn(
      username = username,
      language = language,
      start = if (child) Section.Home else start,
      api = api,
      child = child,
      catalogue = child && catalogue,
      avatar = avatar,
    )
    refreshCanSwitch()
  }

  /** Whether this account may switch is the administrator's choice and can change while the
   *  session lives; the entries in Settings and on the rail follow what the server says now. */
  fun refreshCanSwitch() {
    val api = (state as? SessionState.SignedIn)?.api ?: return
    viewModelScope.launch {
      val me = try {
        api.me() as? MeResult.SignedIn ?: return@launch
      } catch (_: Exception) {
        return@launch
      }
      val current = state as? SessionState.SignedIn ?: return@launch
      if (current.api !== api) return@launch
      state = current.copy(
        canSwitch = me.canSwitch,
        child = me.child,
        catalogue = me.child && me.catalogue,
        start = if (me.child) Section.Home else current.start,
        avatar = me.avatar,
      )
    }
  }

  /** Re-reads the live account policy when the app returns to the foreground. A failed read leaves
   *  the current session untouched; a changed policy gets a fresh session and clears Watch Next. */
  fun refreshPolicy() {
    val current = state as? SessionState.SignedIn ?: return
    val address = store.serverUrl?.let(ServerAddress::parse) ?: return
    viewModelScope.launch {
      val me = try {
        current.api.me() as? MeResult.SignedIn ?: return@launch
      } catch (_: Exception) {
        return@launch
      }
      val latest = state as? SessionState.SignedIn ?: return@launch
      if (latest.api !== current.api) return@launch
      val catalogue = me.child && me.catalogue
      if (latest.child == me.child && latest.catalogue == catalogue) {
        if (latest.avatar == current.avatar && latest.avatar != me.avatar) state = latest.copy(avatar = me.avatar)
        return@launch
      }
      val api = ApiClient(address, CookieStore(address.origin, store))
      val start = if (me.child) Section.Home else startSection(settingsOf(api))
      appContext?.let { WatchNextPublisher.clear(it) }
      state = SessionState.SignedIn(
        username = me.username,
        language = me.language,
        start = start,
        api = api,
        canSwitch = me.canSwitch,
        child = me.child,
        catalogue = catalogue,
        avatar = me.avatar,
      )
    }
  }

  fun switchedProfile() {
    val address = store.serverUrl?.let(ServerAddress::parse) ?: return
    viewModelScope.launch {
      val api = ApiClient(address, CookieStore(address.origin, store))
      try {
        when (val me = api.me()) {
          is MeResult.SignedIn -> {
            appContext?.let { WatchNextPublisher.clear(it) }
            state = signedInState(me, api)
          }
          MeResult.Setup -> {
            store.clearSession()
            state = SessionState.SignedOut(address.display, ApiFailure.NeedsSetup)
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

  fun changeServer() {
    state = SessionState.SignedOut(store.serverUrl ?: DEFAULT_ADDRESS, null)
  }

  /** The interface language of this session: /api/auth/me answers it at first, a Settings pick
   *  replaces it. It is the one place the app's language lives, so a locale change cannot
   *  re-apply an older one when the activity is recreated. */
  fun setLanguage(code: String) {
    val signedIn = state as? SessionState.SignedIn ?: return
    if (signedIn.language == code) return
    state = signedIn.copy(language = code)
  }

  fun setAvatar(avatar: AvatarDto?) {
    val signedIn = state as? SessionState.SignedIn ?: return
    state = signedIn.copy(avatar = avatar)
  }

  fun signOut() {
    val address = store.serverUrl?.let(ServerAddress::parse)
    viewModelScope.launch {
      if (address != null) ApiClient(address, CookieStore(address.origin, store)).logout()
      store.clearSession()
      SpoilerSetting.lastKnown = false
      state = SessionState.SignedOut(address?.display ?: DEFAULT_ADDRESS, null)
    }
  }

  private suspend fun settingsOf(api: ApiClient): String? =
    try {
      // The account's spoiler choice is known before the first detail opens, so its stills do
      // not show sharp until that screen's own settings call answers.
      api.settings().also { SpoilerSetting.lastKnown = it.hideSpoilers }.startView
    } catch (_: ApiError) {
      SpoilerSetting.lastKnown = false
      null
    }

  private suspend fun signedInState(me: MeResult.SignedIn, api: ApiClient): SessionState.SignedIn {
    val start = if (me.child) Section.Home else startSection(settingsOf(api))
    return SessionState.SignedIn(
      username = me.username,
      language = me.language,
      start = start,
      api = api,
      canSwitch = me.canSwitch,
      child = me.child,
      catalogue = me.child && me.catalogue,
      avatar = me.avatar,
    )
  }

  companion object {
    const val DEFAULT_ADDRESS = "http://"

    fun factory(store: SessionStore, appContext: Context? = null) =
      viewModelFactory { initializer { SessionViewModel(store, appContext) } }
  }
}

@Composable
@Suppress("DEPRECATION")
fun AppRoot() {
  LocalNetworkAccessGate {
    AppContent()
  }
}

@Composable
@Suppress("DEPRECATION")
@OptIn(ExperimentalCoilApi::class)
private fun AppContent() {
  val context = LocalContext.current
  val watchNextClearScope = remember { CoroutineScope(SupervisorJob() + Dispatchers.IO) }
  DisposableEffect(watchNextClearScope) {
    onDispose { watchNextClearScope.cancel() }
  }
  val store = remember { SessionStore(context.applicationContext) }
  val session = viewModel<SessionViewModel>(factory = SessionViewModel.factory(store, context.applicationContext))
  when (val state = session.state) {
    SessionState.Loading -> Box(Modifier.fillMaxSize().appBackground())

    is SessionState.SignedOut -> {
      val signIn = viewModel<SignInViewModel>(factory = SignInViewModel.factory(store, session::signedIn))
      LaunchedEffect(state.address, state.error) { signIn.reset(state.address, state.error) }
      SignInScreen(signIn, prefillAddress = state.address)
    }

    is SessionState.SignedIn -> {
      val lifecycleOwner = LocalLifecycleOwner.current
      DisposableEffect(lifecycleOwner, state.api) {
        val observer = LifecycleEventObserver { _, event ->
          if (event == Lifecycle.Event.ON_RESUME) session.refreshPolicy()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
      }
      // The account's interface language from /api/auth/me is the app's locale from the first
      // frame, and every later pick goes through the session too.
      SessionLocale(session)
      val imageDiskCache = remember(state.api.serverAddress, state.username) {
        sessionImageDiskCache(context.applicationContext, state.api.serverAddress, state.username)
      }
      DisposableEffect(imageDiskCache) { onDispose { imageDiskCache.shutdown() } }
      val imageLoader = remember(state.api, imageDiskCache) {
        ImageLoader.Builder(context.applicationContext)
          .diskCache(imageDiskCache)
          .components {
            add(SvgDecoder.Factory())
            add(
              OkHttpNetworkFetcherFactory(
                callFactory = { state.api.http },
                cacheStrategy = { CacheControlCacheStrategy() },
              ),
            )
          }
          .build()
      }
      DisposableEffect(imageLoader) { onDispose { imageLoader.shutdown() } }
      val hostActivity = context.hostActivity()
      CompositionLocalProvider(
        LocalSessionImageLoader provides imageLoader,
        LocalProfileServer provides state.api.serverAddress,
      ) {
        SessionShell(
          api = state.api,
          start = state.start,
          username = state.username,
          address = state.api.serverAddress,
          canSwitch = state.canSwitch,
          child = state.child,
          childCatalogue = state.catalogue,
          avatar = state.avatar,
          profileApi = state.api,
          onSwitched = session::switchedProfile,
          onProfilesGone = session::refreshCanSwitch,
          onSignOut = {
            watchNextClearScope.launch {
              WatchNextPublisher.clear(context.applicationContext)
              withContext(Dispatchers.Main) { session.signOut() }
            }
          },
          onExitApp = { hostActivity?.finish() },
          onLocale = session::setLanguage,
          onAvatarChanged = session::setAvatar,
        )
      }
    }

    is SessionState.Offline -> OfflinePanel(
      server = state.server,
      onRetry = session::restore,
      onChangeServer = session::changeServer,
    )
  }
}

/**
 * Applies the signed-in session's language whenever it changes; [apply] is the platform call, so a
 * test can watch which language the session ends up on.
 */
@Composable
fun SessionLocale(session: SessionViewModel, apply: (String?) -> Unit = ::applyAppLocale) {
  val language = (session.state as? SessionState.SignedIn)?.language
  LaunchedEffect(language) { apply(language) }
}

/**
 * The shell of one signed-in session. The view-model store is keyed to the `ApiClient` and cleared
 * on sign-out, so a new sign-in never reuses the previous account's view models or its client.
 */
@Composable
fun SessionShell(
  api: TvApi,
  start: Section,
  username: String,
  onSignOut: () -> Unit,
  onExitApp: () -> Unit = {},
  address: String = "http://",
  onLocale: (String) -> Unit = {},
  canSwitch: Boolean = false,
  child: Boolean = false,
  childCatalogue: Boolean = false,
  avatar: AvatarDto? = null,
  profileApi: ProfileApi? = null,
  onSwitched: () -> Unit = {},
  onProfilesGone: () -> Unit = {},
  onAvatarChanged: (AvatarDto?) -> Unit = {},
) {
  SessionContent(api) {
    Shell(
      start = start,
      api = api,
      username = username,
      onSignOut = onSignOut,
      onExitApp = onExitApp,
      address = address,
      onLocale = onLocale,
      canSwitch = canSwitch,
      child = child,
      childCatalogue = childCatalogue,
      avatar = avatar,
      profileApi = profileApi,
      onSwitched = onSwitched,
      onProfilesGone = onProfilesGone,
      onAvatarChanged = onAvatarChanged,
    )
  }
}

/** The activity the composition sits in, so the confirmed Back-to-exit can close it. */
private tailrec fun Context.hostActivity(): Activity? = when (this) {
  is Activity -> this
  is ContextWrapper -> baseContext.hostActivity()
  else -> null
}

/** The session-scoped store around [content]; the shell of one signed-in session. */
@Composable
fun SessionContent(api: TvApi, content: @Composable () -> Unit) {
  val owner = remember(api) { SessionViewModelStoreOwner() }
  DisposableEffect(api) { onDispose { owner.viewModelStore.clear() } }
  // Keyed too, not only the store: a profile switch keeps this call site, and every
  // remember and LaunchedEffect(Unit) below would otherwise carry over to the new account.
  key(api) { CompositionLocalProvider(LocalViewModelStoreOwner provides owner) { content() } }
}

/** The view-model store of one signed-in session; a new sign-in gets a fresh instance. */
private class SessionViewModelStoreOwner : ViewModelStoreOwner {
  override val viewModelStore = ViewModelStore()
}

@Composable
internal fun OfflinePanel(server: String, onRetry: () -> Unit, onChangeServer: () -> Unit) {
  val shape = RoundedCornerShape(12.dp)
  // Nothing else on screen holds focus, so without this the first press of the remote only wakes it.
  val retryFocus = remember { FocusRequester() }
  LaunchedEffect(Unit) { runCatching { retryFocus.requestFocus() } }
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
        FocusButton(stringResource(R.string.tv_try_again), onClick = onRetry, modifier = Modifier.focusRequester(retryFocus), kind = FocusButtonKind.Primary)
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
