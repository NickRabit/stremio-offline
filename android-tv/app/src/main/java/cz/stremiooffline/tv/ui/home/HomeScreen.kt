package cz.stremiooffline.tv.ui.home

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Glow
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import coil.compose.AsyncImage
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.DownloadDto
import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.data.displayTitle
import cz.stremiooffline.tv.data.episodeCodeText
import cz.stremiooffline.tv.data.isWideKind
import cz.stremiooffline.tv.data.progressFraction
import cz.stremiooffline.tv.data.wideImage
import cz.stremiooffline.tv.data.yearText
import cz.stremiooffline.tv.ui.components.CardRowInset
import cz.stremiooffline.tv.ui.components.PosterCard
import cz.stremiooffline.tv.ui.components.ShimmerCard
import cz.stremiooffline.tv.ui.components.ShimmerCards
import cz.stremiooffline.tv.ui.components.WideCard
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlin.math.roundToInt
import kotlinx.coroutines.delay

const val TagDownloadsStrip = "home_downloads_strip"
const val TagBackdropTitle = "home_backdrop_title"

fun homeCardTag(key: String): String = "card:$key"

fun homeRowTag(rowId: String): String = "row:$rowId"

fun homeRetryTag(rowId: String): String = "home_retry:$rowId"

private const val StripId = "downloads"
private val BackdropHeight = 300.dp
private val RowsTop = 270.dp
private val RowGap = 14.dp
private const val PlaceholderCards = 5

/**
 * The rail's Home: rows in the server's order, a backdrop that follows focus, lazy addon
 * carousels and the Downloads strip at the end.
 */
@Composable
fun HomeScreen(
  api: TvApi,
  onAction: (HomeAction) -> Unit,
  onHint: (String) -> Unit,
  modifier: Modifier = Modifier,
  refreshToken: Int = 0,
) {
  val viewModel = viewModel<HomeViewModel>(factory = HomeViewModel.factory(api))
  LaunchedEffect(Unit) { viewModel.start() }
  LaunchedEffect(refreshToken) { if (refreshToken > 0) viewModel.refresh() }
  val state = viewModel.state
  val imageUrl = remember(api) { { path: String? -> path?.let(api::url) } }
  val downloadsLater = stringResource(R.string.tv_downloads_later)

  // A catalogue row that came back before the addon answered is asked again, three times.
  state.rows.forEach { slot ->
    val content = slot.content
    if (slot.catalog && content is RowContent.Cards && content.partial && slot.attempts < PARTIAL_RETRIES) {
      key(slot.id, slot.answerSeq) {
        LaunchedEffect(slot.answerSeq) {
          delay(PARTIAL_RETRY_MS)
          viewModel.autoRetry(slot.id)
        }
      }
    }
  }

  Box(modifier.fillMaxSize()) {
    when {
      state.failed -> HomeErrorPanel(onRetry = viewModel::refresh)
      state.loading && state.rows.isEmpty() -> HomeLoading()
      else -> HomeBody(
        state = state,
        imageUrl = imageUrl,
        onAction = onAction,
        onReveal = viewModel::reveal,
        onRetry = viewModel::retry,
        onDownloads = { onHint(downloadsLater) },
      )
    }
  }
}

@Composable
private fun HomeLoading() {
  Column(
    modifier = Modifier.fillMaxSize().padding(start = Tokens.SafeX, top = RowsTop),
    verticalArrangement = Arrangement.spacedBy(RowGap),
  ) {
    repeat(3) { ShimmerCards() }
  }
}

@Composable
private fun HomeErrorPanel(onRetry: () -> Unit) {
  val requester = remember { FocusRequester() }
  LaunchedEffect(Unit) { runCatching { requester.requestFocus() } }
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Column(verticalArrangement = Arrangement.spacedBy(11.dp), horizontalAlignment = Alignment.CenterHorizontally) {
      Text(stringResource(R.string.tv_home_load_error), color = Tokens.Muted, fontSize = 12.sp)
      ErrorRetry(onRetry, requester)
    }
  }
}

@Composable
private fun HomeEmptyPanel() {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Column(verticalArrangement = Arrangement.spacedBy(7.dp), horizontalAlignment = Alignment.CenterHorizontally) {
      Text(stringResource(R.string.home_empty_title), color = Tokens.Text, fontSize = 20.sp, fontWeight = FontWeight.ExtraBold)
      Text(stringResource(R.string.home_empty_text), color = Tokens.Muted, fontSize = 12.sp)
    }
  }
}

@Composable
private fun ErrorRetry(onRetry: () -> Unit, requester: FocusRequester) {
  Surface(
    onClick = onRetry,
    modifier = Modifier.focusRequester(requester),
    shape = ClickableSurfaceDefaults.shape(shape = RoundedCornerShape(10.dp)),
    colors = ClickableSurfaceDefaults.colors(
      containerColor = Tokens.Panel2,
      contentColor = Tokens.Text,
      focusedContainerColor = Tokens.Accent,
      focusedContentColor = Color.White,
    ),
  ) {
    Text(stringResource(R.string.home_retry), fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp))
  }
}

@Composable
private fun HomeBody(
  state: HomeState,
  imageUrl: (String?) -> String?,
  onAction: (HomeAction) -> Unit,
  onReveal: (String) -> Unit,
  onRetry: (String) -> Unit,
  onDownloads: () -> Unit,
) {
  val slots = state.rows.filter { drawnContent(it.content) }
  val downloads = homeQueue(state.downloads)
  val attention = attentionCount(state.downloads)
  val allEmpty = state.rows.isNotEmpty() &&
    state.rows.all { slot -> (slot.content as? RowContent.Cards)?.let { it.items.isEmpty() && !it.partial } == true }

  if (allEmpty && downloads.isEmpty()) {
    HomeEmptyPanel()
    return
  }

  var focusedRowId by remember { mutableStateOf<String?>(null) }
  var focusedCardIndex by remember { mutableIntStateOf(0) }
  var focusedCardKey by remember { mutableStateOf<String?>(null) }
  val cardMemory = remember { mutableStateMapOf<String, Int>() }
  // Keyed by the card's own key, not the index, so a reindexed row keeps the right targets.
  val requesters = remember { mutableMapOf<Pair<String, String>, FocusRequester>() }
  val rowHeights = remember { mutableStateMapOf<String, Int>() }
  val gapPx = with(LocalDensity.current) { RowGap.toPx() }

  val rowIds = slots.map { it.id } + if (downloads.isNotEmpty()) listOf(StripId) else emptyList()
  val focusedIndex = rowIds.indexOf(focusedRowId).takeIf { it >= 0 } ?: 0
  val focusedSlot = slots.getOrNull(focusedIndex)
  val focusedItems = (focusedSlot?.content as? RowContent.Cards)?.items.orEmpty()
  val focusedCard = focusedItems.getOrNull(focusedCardIndex.coerceIn(0, maxOf(0, focusedItems.lastIndex)))

  fun focusCard(index: Int, cardIndex: Int): Boolean {
    val rowId = rowIds.getOrNull(index) ?: return false
    val items = (slots.getOrNull(index)?.content as? RowContent.Cards)?.items
    val count = if (items != null) items.size else 1
    val target = cardIndex.coerceIn(0, maxOf(0, count - 1))
    val key = items?.getOrNull(target)?.key ?: "index:$target"
    val fallback = items?.firstOrNull()?.key ?: "index:0"
    val requester = requesters[rowId to key] ?: requesters[rowId to fallback] ?: return false
    return runCatching { requester.requestFocus() }.isSuccess
  }

  fun revealNear(rowIndex: Int) {
    for (index in 0..rowIndex + 1) {
      val slot = slots.getOrNull(index) ?: continue
      if (slot.catalog && slot.content == RowContent.Placeholder) onReveal(slot.id)
    }
  }

  // Captured during composition: a row whose focused card disappears moves focus itself while
  // the change is applied, so the intent has to be read before that happens.
  val restoreRowId = focusedRowId
  val restoreCardKey = focusedCardKey
  val restoreMemory = focusedRowId?.let { cardMemory[it] } ?: focusedCardIndex

  // The first focus, and the restore after a refresh: the remembered card, else the nearest one
  // in the row, else the first row.
  LaunchedEffect(rowIds, state.dataVersion) {
    val index = rowIds.indexOf(restoreRowId).takeIf { it >= 0 } ?: 0
    val rowId = rowIds.getOrNull(index) ?: return@LaunchedEffect
    val items = (slots.getOrNull(index)?.content as? RowContent.Cards)?.items.orEmpty()
    // The card's key wins; a card that is gone leaves the neighbouring slot in the same row.
    val byKey = restoreCardKey?.let { key -> items.indexOfFirst { it.key == key } }?.takeIf { it >= 0 }
    focusCard(index, byKey ?: restoreMemory.coerceIn(0, maxOf(0, items.lastIndex)))
    revealNear(index)
  }

  val offset by animateFloatAsState(
    targetValue = rowIds.take(focusedIndex).sumOf { (rowHeights[it] ?: 0).toDouble() }.toFloat() + focusedIndex * gapPx,
    animationSpec = tween(280),
    label = "homeRows",
  )

  Box(Modifier.fillMaxSize()) {
    if (focusedCard != null) {
      Backdrop(row = focusedSlot, card = focusedCard, imageUrl = imageUrl)
    }

    Box(
      Modifier
        .fillMaxSize()
        .padding(top = RowsTop)
        .clipToBounds()
        .onPreviewKeyEvent { event ->
          if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
          when (event.key) {
            Key.DirectionDown -> {
              focusedIndex < rowIds.lastIndex &&
                focusCard(focusedIndex + 1, cardMemory[rowIds[focusedIndex + 1]] ?: 0)
            }
            Key.DirectionUp -> {
              focusedIndex > 0 &&
                focusCard(focusedIndex - 1, cardMemory[rowIds[focusedIndex - 1]] ?: 0)
            }
            else -> false
          }
        },
    ) {
      // `unbounded` so the rows keep their natural height: the clip above them is only a viewport,
      // and a bounded Column would squeeze the later rows to nothing.
      Column(
        Modifier
          .offset { IntOffset(0, -offset.roundToInt()) }
          .wrapContentHeight(Alignment.Top, unbounded = true),
        verticalArrangement = Arrangement.spacedBy(RowGap),
      ) {
        slots.forEachIndexed { index, slot ->
          HomeRowView(
            slot = slot,
            isFocusedRow = index == focusedIndex,
            focusedCardIndex = if (index == focusedIndex) focusedCardIndex else 0,
            dim = index < focusedIndex,
            imageUrl = imageUrl,
            requesters = requesters,
            onCardFocus = { cardIndex ->
              focusedRowId = slot.id
              focusedCardIndex = cardIndex
              focusedCardKey = (slot.content as? RowContent.Cards)?.items?.getOrNull(cardIndex)?.key
              cardMemory[slot.id] = cardIndex
              revealNear(index)
            },
            onCardClick = { card -> onAction(actionFor(card)) },
            onRetry = { onRetry(slot.id) },
            onSize = { rowHeights[slot.id] = it },
          )
        }
        if (downloads.isNotEmpty()) {
          val stripRequester = remember { FocusRequester() }
          DownloadsStrip(
            jobs = downloads,
            attention = attention,
            onSize = { rowHeights[StripId] = it },
            onClick = onDownloads,
            requester = stripRequester.also { requesters[StripId to "index:0"] = it },
            onFocus = {
              focusedRowId = StripId
              focusedCardIndex = 0
            },
          )
        }
      }
    }
  }
}

@Composable
private fun Backdrop(row: HomeRowSlot?, card: HomeCard, imageUrl: (String?) -> String?) {
  Box(Modifier.fillMaxWidth().height(BackdropHeight).clipToBounds()) {
    Crossfade(
      targetState = imageUrl(card.wideImage),
      animationSpec = tween(350),
      label = "homeBackdrop",
    ) { art ->
      Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Tokens.Panel2, Tokens.Bg)))) {
        if (art != null) {
          AsyncImage(model = art, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        }
      }
    }
    Box(
      Modifier
        .fillMaxSize()
        .background(Brush.horizontalGradient(listOf(Tokens.Bg, Tokens.Bg.copy(alpha = 0.75f), Color.Transparent))),
    )
    Box(
      Modifier
        .fillMaxSize()
        .background(Brush.verticalGradient(listOf(Color.Transparent, Tokens.Bg.copy(alpha = 0.7f), Tokens.Bg))),
    )

    Column(
      modifier = Modifier.padding(start = 32.dp, top = 48.dp).width(560.dp),
      verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      if (row != null) {
        Text(
          rowTitle(row).uppercase(),
          color = Tokens.Accent,
          fontSize = 9.sp,
          fontWeight = FontWeight.Bold,
          letterSpacing = 1.6.sp,
        )
      }
      Text(
        card.displayTitle,
        color = Tokens.Text,
        fontSize = 34.sp,
        lineHeight = 36.sp,
        fontWeight = FontWeight.ExtraBold,
        letterSpacing = (-1).sp,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.testTag(TagBackdropTitle),
      )
      val meta = listOfNotNull(card.yearText, card.episodeCodeText).joinToString(" · ")
      if (meta.isNotEmpty()) {
        Text(meta, color = Tokens.Muted, fontSize = 11.5.sp, fontWeight = FontWeight.Medium)
      }
      card.progressFraction?.let { fraction ->
        val percent = (fraction * 100).roundToInt()
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
          Box(Modifier.width(140.dp).height(3.dp).clip(RoundedCornerShape(999.dp)).background(Tokens.Line)) {
            Box(Modifier.fillMaxWidth(fraction).height(3.dp).background(Tokens.Accent))
          }
          Text(stringResource(R.string.tv_detail_watched, percent.toString()), color = Tokens.Muted, fontSize = 10.sp)
        }
      }
    }
  }
}

@Composable
private fun rowTitle(slot: HomeRowSlot): String {
  val builtin = builtinRowTitle(slot.id)
  return if (builtin != null) stringResource(builtin) else slot.title.orEmpty()
}

@Composable
private fun HomeRowView(
  slot: HomeRowSlot,
  isFocusedRow: Boolean,
  focusedCardIndex: Int,
  dim: Boolean,
  imageUrl: (String?) -> String?,
  requesters: MutableMap<Pair<String, String>, FocusRequester>,
  onCardFocus: (Int) -> Unit,
  onCardClick: (HomeCard) -> Unit,
  onRetry: () -> Unit,
  onSize: (Int) -> Unit,
) {
  Column(
    modifier = Modifier
      .fillMaxWidth()
      .padding(start = Tokens.SafeX, end = Tokens.SafeX)
      .alpha(if (dim) 0.55f else 1f)
      .onSizeChanged { onSize(it.height) },
  ) {
    Text(
      rowTitle(slot),
      color = Tokens.Text,
      fontSize = 15.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = (-0.2).sp,
      modifier = Modifier.padding(start = CardRowInset),
    )
    Spacer(Modifier.height(9.dp))
    when (val content = slot.content) {
      RowContent.Placeholder, RowContent.Loading -> PlaceholderRow(slot.id, requesters, onCardFocus)
      RowContent.Error -> {
        // The retry button is the row's only focusable, so DOWN/UP can land on it.
        val requester = remember(slot.id) { FocusRequester() }
        requesters[slot.id to "index:0"] = requester
        RowNote(stringResource(R.string.home_row_failed), homeRetryTag(slot.id), requester, onRetry) { onCardFocus(0) }
      }
      is RowContent.Cards -> {
        if (content.partial) {
          val requester = remember(slot.id) { FocusRequester() }
          requesters[slot.id to "index:0"] = requester
          RowNote(stringResource(R.string.home_partial), homeRetryTag(slot.id), requester, onRetry) { onCardFocus(0) }
          Spacer(Modifier.height(6.dp))
        }
        val listState = remember(slot.id) { LazyListState() }
        LaunchedEffect(isFocusedRow, focusedCardIndex) {
          if (isFocusedRow) listState.animateScrollToItem(focusedCardIndex.coerceAtLeast(0))
        }
        LazyRow(
          state = listState,
          contentPadding = PaddingValues(horizontal = CardRowInset),
          horizontalArrangement = Arrangement.spacedBy(RowGap),
          modifier = Modifier.testTag(homeRowTag(slot.id)),
        ) {
          itemsIndexed(content.items, key = { _, card -> card.key }) { index, card ->
            val requester = remember(slot.id, index) { FocusRequester() }
            requesters[slot.id to card.key] = requester
            HomeCardView(
              card = card,
              imageUrl = imageUrl,
              modifier = Modifier
                .focusRequester(requester)
                .onFocusChanged { if (it.isFocused) onCardFocus(index) },
              cardTag = homeCardTag(card.key),
              onClick = { onCardClick(card) },
            )
          }
        }
      }
    }
  }
}

@Composable
private fun PlaceholderRow(rowId: String, requesters: MutableMap<Pair<String, String>, FocusRequester>, onCardFocus: (Int) -> Unit) {
  Row(
    modifier = Modifier.padding(start = CardRowInset),
    horizontalArrangement = Arrangement.spacedBy(RowGap),
  ) {
    repeat(PlaceholderCards) { index ->
      val requester = remember(rowId, index) { FocusRequester() }
      requesters[rowId to "index:$index"] = requester
      ShimmerCard(
        modifier = Modifier
          .testTag("$rowId:$index")
          .focusRequester(requester)
          .focusable()
          .onFocusChanged { if (it.isFocused) onCardFocus(index) },
      )
    }
  }
}

@Composable
private fun RowNote(text: String, retryTag: String, requester: FocusRequester, onRetry: () -> Unit, onFocus: () -> Unit) {
  Row(
    modifier = Modifier.padding(start = CardRowInset),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(11.dp),
  ) {
    Text(text, color = Tokens.Muted, fontSize = 11.sp)
    Surface(
      onClick = onRetry,
      modifier = Modifier
        .testTag(retryTag)
        .focusRequester(requester)
        .onFocusChanged { if (it.isFocused) onFocus() },
      shape = ClickableSurfaceDefaults.shape(shape = RoundedCornerShape(8.dp)),
      colors = ClickableSurfaceDefaults.colors(
        containerColor = Tokens.Panel2,
        contentColor = Tokens.Text,
        focusedContainerColor = Tokens.Accent,
        focusedContentColor = Color.White,
      ),
    ) {
      Text(stringResource(R.string.home_retry), fontSize = 11.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
    }
  }
}

@Composable
private fun HomeCardView(
  card: HomeCard,
  imageUrl: (String?) -> String?,
  modifier: Modifier,
  cardTag: String,
  onClick: () -> Unit,
) {
  val label = cardLabel(card)?.let { stringResource(it) }
  val caption = captionOf(card, label)
  val title = card.displayTitle
  if (card.isWideKind) {
    WideCard(
      label = title,
      imageUrl = imageUrl(card.wide),
      fallbackImageUrl = imageUrl(card.poster),
      progress = card.progressFraction,
      completed = false,
      onClick = onClick,
      modifier = modifier,
      cardTag = cardTag,
      caption = caption,
    )
  } else {
    PosterCard(
      name = title,
      imageUrl = imageUrl(card.poster),
      fallbackImageUrl = imageUrl(card.wide),
      progress = card.progressFraction,
      onClick = onClick,
      modifier = modifier,
      caption = caption,
      cardTag = cardTag,
    )
  }
}

@Composable
private fun DownloadsStrip(
  jobs: List<DownloadDto>,
  attention: Int,
  requester: FocusRequester,
  onSize: (Int) -> Unit,
  onFocus: () -> Unit,
  onClick: () -> Unit,
) {
  val shape = RoundedCornerShape(12.dp)
  Column(Modifier.fillMaxWidth().padding(start = Tokens.SafeX, end = Tokens.SafeX).onSizeChanged { onSize(it.height) }) {
    Text(stringResource(R.string.home_downloads), color = Tokens.Text, fontSize = 15.sp, fontWeight = FontWeight.Bold)
    Spacer(Modifier.height(9.dp))
    Surface(
      onClick = onClick,
      modifier = Modifier
        .testTag(TagDownloadsStrip)
        .focusRequester(requester)
        .onFocusChanged { if (it.isFocused) onFocus() },
      shape = ClickableSurfaceDefaults.shape(shape = shape),
      scale = ClickableSurfaceDefaults.scale(focusedScale = 1.02f),
      glow = ClickableSurfaceDefaults.glow(focusedGlow = Glow(Tokens.Accent2.copy(alpha = 0.35f), 18.dp)),
      border = ClickableSurfaceDefaults.border(
        border = Border(BorderStroke(1.dp, Tokens.Line), shape = shape),
        focusedBorder = Border(BorderStroke(2.dp, Tokens.Accent2), shape = shape),
      ),
      colors = ClickableSurfaceDefaults.colors(containerColor = Tokens.Panel, focusedContainerColor = Tokens.Panel2),
    ) {
      Row(
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
      ) {
        Text(
          pluralStringResource(R.plurals.home_downloads_summary, jobs.size, jobs.size),
          color = Tokens.Text,
          fontSize = 13.sp,
          fontWeight = FontWeight.SemiBold,
        )
        if (attention > 0) {
          Text(
            pluralStringResource(R.plurals.home_attention, attention, attention),
            color = Tokens.Red,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
          )
        }
      }
    }
  }
}
