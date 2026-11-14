package cz.stremiooffline.tv.ui.person

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.CatalogApi
import cz.stremiooffline.tv.data.PersonFilmographyDto
import cz.stremiooffline.tv.data.PersonSectionDto
import cz.stremiooffline.tv.data.PersonTitleDto
import cz.stremiooffline.tv.data.RelatedTitleDto
import cz.stremiooffline.tv.ui.catalog.posterGridColumns
import cz.stremiooffline.tv.ui.components.CardRowInset
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.PosterCard
import cz.stremiooffline.tv.ui.sessionImageLoader
import cz.stremiooffline.tv.ui.signin.messageRes
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.android.awaitFrame
import kotlinx.coroutines.launch

data class PersonArgs(val id: Long, val name: String)

const val TagPersonScreen = "person_screen"
const val TagPersonRetry = "person_retry"

fun personTileTag(title: PersonTitleDto): String = "person_tile_${title.type}_${title.tmdbId}"
fun personSectionTag(section: PersonSectionDto): String = "person_section_${section.key}"

private fun PersonTitleDto.focusKey(): String = "$type:$tmdbId"

@Composable
fun PersonScreen(
  api: CatalogApi,
  args: PersonArgs,
  language: String?,
  imageUrl: (String?) -> String?,
  restoreFocusToken: Int,
  onOpenTitle: (RelatedTitleDto, noImdb: Boolean) -> Unit,
  onUnavailable: (String) -> Unit,
  onBack: () -> Unit,
) {
  var retry by remember(args) { mutableIntStateOf(0) }
  var person by remember(args) { mutableStateOf<PersonFilmographyDto?>(null) }
  var failure by remember(args) { mutableStateOf<ApiError?>(null) }
  var notice by remember(args) { mutableStateOf<ApiError?>(null) }
  var openingKey by remember(args) { mutableStateOf<String?>(null) }
  var lastOpenedKey by remember(args) { mutableStateOf<String?>(null) }
  val requesters = remember(args) { mutableMapOf<String, FocusRequester>() }
  val retryFocus = remember(args) { FocusRequester() }
  val scope = rememberCoroutineScope()

  fun requester(key: String): FocusRequester = requesters.getOrPut(key) { FocusRequester() }

  BackHandler(onBack = onBack)

  LaunchedEffect(args, retry) {
    person = null
    failure = null
    notice = null
    try {
      person = api.person(args.id, language)
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (error: ApiError) {
      if (error.messageKey == "err.personUnavailable") {
        onUnavailable(args.name)
      } else {
        failure = error
      }
    } catch (_: Exception) {
      failure = ApiError(ApiFailure.Generic)
    }
  }

  val firstTitle = person?.sections?.firstNotNullOfOrNull { it.titles.firstOrNull() }
  LaunchedEffect(person) {
    if (firstTitle == null) return@LaunchedEffect
    awaitFrame()
    runCatching { requester(firstTitle.focusKey()).requestFocus() }
  }
  LaunchedEffect(failure) {
    if (failure == null) return@LaunchedEffect
    awaitFrame()
    runCatching { retryFocus.requestFocus() }
  }
  LaunchedEffect(restoreFocusToken) {
    val key = lastOpenedKey ?: return@LaunchedEffect
    awaitFrame()
    runCatching { requester(key).requestFocus() }
  }

  fun open(title: PersonTitleDto) {
    if (openingKey != null) return
    val key = title.focusKey()
    lastOpenedKey = key
    notice = null
    when {
      title.id.startsWith("tt") -> onOpenTitle(title.related(title.id), false)
      title.id.startsWith("tmdb:") -> {
        openingKey = key
        scope.launch {
          try {
            val resolved = api.personTitle(title.type, title.tmdbId)
            onOpenTitle(title.related(resolved.id), resolved.imdb == "none")
          } catch (cancelled: CancellationException) {
            throw cancelled
          } catch (error: ApiError) {
            notice = error
          } catch (_: Exception) {
            notice = ApiError(ApiFailure.Generic)
          } finally {
            if (openingKey == key) openingKey = null
          }
        }
      }
    }
  }

  Column(
    Modifier
      .fillMaxSize()
      .background(Tokens.Bg)
      .testTag(TagPersonScreen)
      .padding(start = Tokens.SafeX, top = Tokens.SafeY, end = Tokens.SafeX),
  ) {
    PersonHeader(
      name = person?.name ?: args.name,
      photo = person?.photo,
      imageUrl = imageUrl,
    )
    when {
      person == null && failure == null -> {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
          Text(stringResource(R.string.person_loading), color = Tokens.Muted, fontSize = 13.sp)
        }
      }
      failure != null -> {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
          Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(apiErrorText(failure!!), color = Tokens.Muted, fontSize = 13.sp)
            FocusButton(
              text = stringResource(R.string.person_retry),
              onClick = { retry++ },
              modifier = Modifier.focusRequester(retryFocus).testTag(TagPersonRetry),
            )
          }
        }
      }
      person != null -> {
        notice?.let {
          Text(
            apiErrorText(it),
            color = Tokens.Red,
            fontSize = 12.sp,
            modifier = Modifier.padding(vertical = 8.dp),
          )
        }
        val sections = person!!.sections.filter { it.key == "acting" || it.key == "crew" }
        if (sections.all { it.titles.isEmpty() }) {
          Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(stringResource(R.string.person_empty), color = Tokens.Muted, fontSize = 13.sp)
          }
        } else {
          PersonGrid(
            sections = sections,
            imageUrl = imageUrl,
            openingKey = openingKey,
            requester = ::requester,
            onOpen = ::open,
          )
        }
      }
    }
  }
}

@Composable
private fun PersonHeader(name: String, photo: String?, imageUrl: (String?) -> String?) {
  Row(
    modifier = Modifier.fillMaxWidth().height(118.dp).padding(vertical = 10.dp),
    horizontalArrangement = Arrangement.spacedBy(18.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    val shape = RoundedCornerShape(10.dp)
    Box(
      Modifier
        .size(width = 68.dp, height = 98.dp)
        .clip(shape)
        .background(Tokens.Panel2),
    ) {
      val art = imageUrl(photo)
      if (art != null) {
        AsyncImage(
          model = art,
          contentDescription = stringResource(R.string.person_label, name),
          imageLoader = sessionImageLoader(),
          contentScale = ContentScale.Crop,
          modifier = Modifier.fillMaxSize(),
        )
      }
    }
    Text(
      name,
      color = Tokens.Text,
      fontSize = 24.sp,
      fontWeight = FontWeight.Bold,
      maxLines = 2,
      overflow = TextOverflow.Ellipsis,
    )
  }
}

@Composable
private fun PersonGrid(
  sections: List<PersonSectionDto>,
  imageUrl: (String?) -> String?,
  openingKey: String?,
  requester: (String) -> FocusRequester,
  onOpen: (PersonTitleDto) -> Unit,
) {
  BoxWithConstraints(Modifier.fillMaxSize()) {
    val columns = posterGridColumns(maxWidth.value)
    val state = rememberLazyGridState()
    LazyVerticalGrid(
      columns = GridCells.Fixed(columns),
      state = state,
      modifier = Modifier.fillMaxSize().focusGroup(),
      contentPadding = PaddingValues(start = CardRowInset, top = 4.dp, end = CardRowInset, bottom = 40.dp),
      horizontalArrangement = Arrangement.spacedBy(18.dp),
      verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
      sections.forEachIndexed { sectionIndex, section ->
        item(key = "section:${section.key}", span = { GridItemSpan(maxLineSpan) }) {
          Text(
            stringResource(
              if (section.key == "acting") R.string.person_acting else R.string.person_crew,
            ),
            color = Tokens.Text,
            fontSize = 15.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.testTag(personSectionTag(section)),
          )
        }
        itemsIndexed(section.titles, key = { _, title -> "${section.key}:${title.focusKey()}" }) { index, title ->
          val key = title.focusKey()
          val next = sections.getOrNull(sectionIndex + 1)?.titles?.firstOrNull()
          val rowStart = index - index % columns
          val lastRow = index >= (section.titles.size - 1) / columns * columns
          val caption = if (openingKey == key) {
            stringResource(R.string.person_opening)
          } else {
            titleCaption(title)
          }
          PosterCard(
            name = title.name,
            imageUrl = imageUrl(title.poster),
            progress = null,
            caption = caption,
            cardTag = personTileTag(title),
            onClick = { onOpen(title) },
            modifier = Modifier
              .focusRequester(requester(key))
              .onPreviewKeyEvent { event ->
                if (
                  event.type == KeyEventType.KeyDown &&
                  event.key == Key.DirectionDown &&
                  next != null &&
                  lastRow &&
                  openingKey == null
                ) {
                  val target = sections[sectionIndex + 1].titles[
                    minOf(index - rowStart, sections[sectionIndex + 1].titles.lastIndex)
                  ]
                  runCatching { requester(target.focusKey()).requestFocus() }.isSuccess
                } else {
                  false
                }
              },
          )
        }
      }
    }
  }
}

@Composable
private fun titleCaption(title: PersonTitleDto): String {
  val kind = stringResource(if (title.type == "series") R.string.person_series else R.string.person_movie)
  return listOfNotNull(
    title.year?.takeIf { it.isNotBlank() },
    kind,
    stringResource(R.string.person_in_library).takeIf { title.inLibrary },
  ).joinToString(" · ")
}

@Composable
private fun apiErrorText(error: ApiError): String =
  if (error.messageKey == "err.personLookupFailed") {
    stringResource(R.string.err_person_lookup_failed)
  } else {
    error.serverMessage ?: stringResource(error.failure.messageRes())
  }

private fun PersonTitleDto.related(id: String) = RelatedTitleDto(
  type = type,
  id = id,
  name = name,
  year = year,
  poster = poster,
)
