package cz.stremiooffline.tv.ui.catalog

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.ShimmerCards
import cz.stremiooffline.tv.ui.components.TvTextField
import cz.stremiooffline.tv.ui.theme.Tokens

const val TagSearchField = "search_field"
const val TagSearchInput = "search_input"
const val TagSearchRetry = "search_retry"

@Composable
fun SearchScreen(
  api: TvApi,
  onOpenDetail: (CatalogDetailArgs) -> Unit,
  imageUrl: (String?) -> String?,
  modifier: Modifier = Modifier,
) {
  val viewModel = viewModel<SearchViewModel>(factory = SearchViewModel.factory(api))
  val state = viewModel.state
  var text by rememberSaveable { mutableStateOf("") }
  val fieldFocus = remember { FocusRequester() }
  val gridFocus = remember { FocusRequester() }

  // Search is everywhere, so an item carries its own addon name for the detail's eyebrow.
  fun open(item: cz.stremiooffline.tv.data.MetaDto) =
    onOpenDetail(CatalogDetailArgs(item, item.addonName.orEmpty(), item.type ?: "movie"))

  LaunchedEffect(Unit) { runCatching { fieldFocus.requestFocus() } }

  Column(
    modifier = modifier.fillMaxSize().padding(start = Tokens.SafeX, top = Tokens.SafeY, end = Tokens.SafeX),
    verticalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    Text(
      stringResource(R.string.tv_nav_search).uppercase(),
      color = Tokens.Accent,
      fontSize = 10.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 1.8.sp,
    )
    TvTextField(
      label = stringResource(R.string.tv_nav_search),
      value = text,
      onValueChange = { text = it },
      imeAction = ImeAction.Done,
      surfaceRequester = fieldFocus,
      testTag = TagSearchField,
      inputTestTag = TagSearchInput,
      onSubmit = { viewModel.submit(text) },
      modifier = Modifier.width(520.dp),
    )
    if (!state.submitted) {
      Text(stringResource(R.string.tv_search_hint), color = Tokens.Muted, fontSize = 12.sp)
    }

    Box(Modifier.weight(1f).fillMaxWidth()) {
      when {
        state.submitted && state.loading -> ShimmerCards()
        state.submitted && state.error -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
          Column(verticalArrangement = Arrangement.spacedBy(11.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(stringResource(R.string.tv_load_error), color = Tokens.Muted, fontSize = 12.sp)
            FocusButton(
              text = stringResource(R.string.tv_try_again),
              onClick = { viewModel.retry() },
              kind = FocusButtonKind.Primary,
              modifier = Modifier.testTag(TagSearchRetry),
            )
          }
        }
        state.submitted -> PosterGrid(
          items = state.items,
          imageUrl = imageUrl,
          onOpen = { open(it) },
          onNearEnd = { viewModel.loadMore() },
          gridFocus = gridFocus,
          modifier = Modifier.fillMaxSize(),
        )
      }
    }
  }
}
