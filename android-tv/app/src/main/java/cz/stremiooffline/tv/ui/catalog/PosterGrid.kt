package cz.stremiooffline.tv.ui.catalog

import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.unit.dp
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.ui.components.PosterCard

/** The poster grid of both the catalogue and search: focus with the D-pad, ask for more when
 *  focus reaches the last row. */
@Composable
fun PosterGrid(
  items: List<MetaDto>,
  imageUrl: (String?) -> String?,
  onOpen: (MetaDto) -> Unit,
  onNearEnd: () -> Unit,
  gridFocus: FocusRequester,
  modifier: Modifier = Modifier,
) {
  BoxWithConstraints(modifier) {
    val columns = (((maxWidth.value + 18f) / 128f).toInt()).coerceAtLeast(1)
    LazyVerticalGrid(
      columns = GridCells.Fixed(columns),
      modifier = Modifier.focusRequester(gridFocus).focusGroup(),
      contentPadding = PaddingValues(start = 10.dp, top = 10.dp, bottom = 40.dp),
      horizontalArrangement = Arrangement.spacedBy(18.dp),
      verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
      itemsIndexed(items, key = { _, item -> "${item.type}:${item.id}" }) { index, item ->
        val requester = remember(item.id) { FocusRequester() }
        PosterCard(
          name = item.name,
          imageUrl = imageUrl(item.poster ?: item.background),
          progress = null,
          cardTag = posterTag(item),
          onClick = { onOpen(item) },
          modifier = Modifier
            .focusRequester(requester)
            .onFocusChanged { if (it.isFocused && index >= items.size - columns) onNearEnd() },
        )
      }
    }
  }
}

fun posterTag(item: MetaDto): String = "poster_${item.type ?: ""}_${item.id}"
