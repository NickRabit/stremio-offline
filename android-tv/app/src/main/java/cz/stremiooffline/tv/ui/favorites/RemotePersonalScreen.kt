package cz.stremiooffline.tv.ui.favorites

import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.RemoteLibraryApi
import cz.stremiooffline.tv.data.displayTitle
import cz.stremiooffline.tv.data.isWideKind
import cz.stremiooffline.tv.data.progressFraction
import cz.stremiooffline.tv.ui.components.CardRowInset
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.PosterCard
import cz.stremiooffline.tv.ui.components.ShimmerCards
import cz.stremiooffline.tv.ui.components.WideCard
import cz.stremiooffline.tv.ui.detail.RemoteDetailData
import cz.stremiooffline.tv.ui.home.captionOf
import cz.stremiooffline.tv.ui.home.remoteDetailOf
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

fun remotePersonalCardTag(key: String): String = "remote_personal:$key"

data class RemotePersonalState(
  val items: List<HomeCard.Remote> = emptyList(),
  val total: Int = 0,
  val loading: Boolean = true,
  val loadingMore: Boolean = false,
  /** The last attempt failed: the cards already loaded stay on screen beside this. */
  val error: Boolean = false,
  /** The server answered incompletely; the cards it did send are shown. */
  val partial: Boolean = false,
)

/** The remote half of a personal list (`favorites` or `resume`). A failed page keeps the cards it
 *  already has and raises `error`/`partial`; it never degrades into a successful empty list. */
class RemotePersonalViewModel(private val api: RemoteLibraryApi, private val filter: String) : ViewModel() {

  var state by mutableStateOf(RemotePersonalState())
    private set

  var selectedKey by mutableStateOf("")

  private var job: Job? = null
  private var started = false

  fun start() {
    if (started) return
    started = true
    load()
  }

  fun retry() = load()

  /** Re-reads the first page; a failure keeps the cards on screen and raises the notice. */
  fun refresh() {
    if (state.loading) return
    job?.cancel()
    job = viewModelScope.launch {
      try {
        val page = api.remotePersonal(filter, skip = 0, limit = PAGE)
        state = state.copy(
          items = page.items.filterIsInstance<HomeCard.Remote>(),
          total = page.total,
          loading = false,
          loadingMore = false,
          error = false,
          partial = page.partial,
        )
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        state = state.copy(loading = false, loadingMore = false, error = true, partial = false)
      }
    }
  }

  fun loadMore() {
    if (state.loading || state.loadingMore || state.items.size >= state.total) return
    state = state.copy(loadingMore = true, error = false)
    job = viewModelScope.launch {
      try {
        val page = api.remotePersonal(filter, skip = state.items.size, limit = PAGE)
        state = state.copy(
          items = distinct(state.items + page.items.filterIsInstance<HomeCard.Remote>()),
          total = page.total,
          loading = false,
          loadingMore = false,
          error = false,
          partial = page.partial,
        )
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        // The rows that did load stay; the notice says more could not be fetched.
        state = state.copy(loadingMore = false, error = true)
      } finally {
        state = state.copy(loadingMore = false)
      }
    }
  }

  private fun load() {
    job?.cancel()
    state = state.copy(loading = true, loadingMore = false, error = false, partial = false)
    job = viewModelScope.launch {
      try {
        val page = api.remotePersonal(filter, skip = 0, limit = PAGE)
        state = state.copy(
          items = page.items.filterIsInstance<HomeCard.Remote>(),
          total = page.total,
          loading = false,
          error = false,
          partial = page.partial,
        )
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        state = state.copy(loading = false, error = true, partial = false)
      } finally {
        state = state.copy(loadingMore = false)
      }
    }
  }

  private fun distinct(items: List<HomeCard.Remote>): List<HomeCard.Remote> {
    val seen = HashSet<String>()
    return items.filter { seen.add(it.key) }
  }

  companion object {
    const val PAGE = 40

    fun factory(api: RemoteLibraryApi, filter: String) =
      viewModelFactory { initializer { RemotePersonalViewModel(api, filter) } }
  }
}

/** The remote personal grid, reusing the library's card components, with a retryable partial or
 *  error notice above the cards and a full retry when nothing loaded at all. */
@Composable
fun RemotePersonalRoute(
  api: RemoteLibraryApi,
  imageUrl: (String?) -> String?,
  filter: String,
  onOpenRemote: (RemoteDetailData) -> Unit,
  modifier: Modifier = Modifier,
  restoreToken: Int = 0,
  refreshToken: Int = 0,
) {
  val viewModel = viewModel<RemotePersonalViewModel>(factory = RemotePersonalViewModel.factory(api, filter))
  LaunchedEffect(Unit) { viewModel.start() }
  LaunchedEffect(refreshToken) { if (refreshToken > 0) viewModel.refresh() }
  LaunchedEffect(restoreToken) { if (restoreToken > 0) viewModel.refresh() }

  val state = viewModel.state
  val gridFocus = remember { FocusRequester() }
  val retryFocus = remember { FocusRequester() }
  val cardFocus = remember { mutableMapOf<String, FocusRequester>() }

  LaunchedEffect(state.loading, state.items.size, state.error, state.partial, restoreToken, refreshToken) {
    if (state.loading && state.items.isEmpty()) return@LaunchedEffect
    val keys = state.items.map { it.key }
    if (keys.isEmpty()) {
      runCatching { (if (state.error || state.partial) retryFocus else gridFocus).requestFocus() }
      return@LaunchedEffect
    }
    // A notice above the grid never takes focus off the card the viewer was on.
    val wanted = viewModel.selectedKey.takeIf { it in keys } ?: keys.first()
    runCatching { (cardFocus[wanted] ?: gridFocus).requestFocus() }
  }

  Column(modifier.fillMaxSize()) {
    if (state.items.isNotEmpty() && (state.error || state.partial)) {
      Row(
        Modifier.fillMaxWidth().padding(bottom = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(11.dp),
      ) {
        Text(
          stringResource(R.string.media_server_personal_partial),
          color = Tokens.Red,
          fontSize = 11.sp,
          maxLines = 1,
          modifier = Modifier.weight(1f),
        )
        FocusButton(stringResource(R.string.tv_try_again), onClick = { viewModel.retry() })
      }
    }
    Box(Modifier.weight(1f).fillMaxWidth()) {
      when {
        state.loading && state.items.isEmpty() -> ShimmerCards()
        (state.error || state.partial) && state.items.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
          FocusButton(
            stringResource(R.string.tv_try_again),
            onClick = { viewModel.retry() },
            kind = FocusButtonKind.Primary,
            modifier = Modifier.focusRequester(retryFocus),
          )
        }
        // The empty grid still holds a focusable target so the remote cannot go dead over it.
        state.items.isEmpty() -> Box(
          Modifier.fillMaxSize().focusRequester(gridFocus).focusable(),
          contentAlignment = Alignment.TopStart,
        ) {
          Text(stringResource(R.string.media_server_personal_empty), color = Tokens.Muted, fontSize = 12.sp)
        }
        else -> BoxWithConstraints(Modifier.fillMaxSize()) {
          val columns = (((maxWidth.value + 18f) / 128f).toInt()).coerceAtLeast(1)
          LazyVerticalGrid(
            columns = GridCells.Fixed(columns),
            modifier = Modifier.focusRequester(gridFocus).focusGroup(),
            contentPadding = PaddingValues(start = CardRowInset, top = 10.dp, end = CardRowInset, bottom = 40.dp),
            horizontalArrangement = Arrangement.spacedBy(18.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
          ) {
            itemsIndexed(state.items, key = { _, card -> card.key }) { index, card ->
              val requester = remember(card.key) { FocusRequester() }
              cardFocus[card.key] = requester
              val focusModifier = Modifier
                .focusRequester(requester)
                .onFocusChanged {
                  if (it.isFocused) {
                    viewModel.selectedKey = card.key
                    cardFocus[card.key] = requester
                    if (index >= state.items.size - columns) viewModel.loadMore()
                  }
                }
              if (card.isWideKind) {
                WideCard(
                  label = card.displayTitle,
                  imageUrl = imageUrl(card.wide),
                  fallbackImageUrl = imageUrl(card.poster),
                  progress = card.progressFraction,
                  completed = false,
                  caption = captionOf(card, null),
                  cardTag = remotePersonalCardTag(card.key),
                  onClick = { onOpenRemote(remoteDetailOf(card)) },
                  modifier = focusModifier,
                )
              } else {
                PosterCard(
                  name = card.displayTitle,
                  imageUrl = imageUrl(card.poster),
                  fallbackImageUrl = imageUrl(card.wide),
                  progress = card.progressFraction,
                  caption = captionOf(card, null),
                  cardTag = remotePersonalCardTag(card.key),
                  onClick = { onOpenRemote(remoteDetailOf(card)) },
                  modifier = focusModifier,
                )
              }
            }
          }
        }
      }
    }
  }
}
