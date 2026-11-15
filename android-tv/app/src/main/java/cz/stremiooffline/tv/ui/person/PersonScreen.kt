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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
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
import cz.stremiooffline.tv.ui.components.CardRowInset
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.TvTextField
import cz.stremiooffline.tv.ui.search.GlobalSearchCard
import cz.stremiooffline.tv.ui.sessionImageLoader
import cz.stremiooffline.tv.ui.signin.messageRes
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.android.awaitFrame
import kotlinx.coroutines.launch

data class PersonArgs(
  val id: Long,
  val name: String,
  val focusKey: String? = null,
  val fromTitle: String? = null,
)

const val TagPersonScreen = "person_screen"
const val TagPersonRetry = "person_retry"
const val TagPersonSearchField = "person_search_field"
const val TagPersonSearchInput = "person_search_input"
const val TagPersonSearchAsText = "person_search_as_text"

fun personTileTag(title: PersonTitleDto): String = "person_tile_${title.type}_${title.tmdbId}"
fun personSectionTag(section: PersonSectionDto): String = "person_section_${section.key}"

private fun PersonTitleDto.focusKey(): String = "$type:$tmdbId"

@Composable
fun PersonScreen(
  api: CatalogApi,
  args: PersonArgs,
  language: String?,
  imageUrl: (String?) -> String?,
  onOpenTitle: (related: RelatedTitleDto, focusKey: String, noImdb: Boolean) -> Unit,
  onUnavailable: (String) -> Unit,
  onSearchText: (String) -> Unit,
  onBack: () -> Unit,
) {
  var retry by remember(args) { mutableIntStateOf(0) }
  var person by remember(args) { mutableStateOf<PersonFilmographyDto?>(null) }
  var failure by remember(args) { mutableStateOf<ApiError?>(null) }
  var notice by remember(args) { mutableStateOf<ApiError?>(null) }
  var openingKey by remember(args) { mutableStateOf<String?>(null) }
  var query by remember(args) { mutableStateOf(args.name) }
  val requesters = remember(args) { mutableMapOf<String, FocusRequester>() }
  val fieldFocus = remember(args) { FocusRequester() }
  val retryFocus = remember(args) { FocusRequester() }
  val scope = rememberCoroutineScope()

  fun requester(key: String): FocusRequester = requesters.getOrPut(key) { FocusRequester() }

  val sections = person?.sections.orEmpty().filter { it.key == "acting" || it.key == "crew" }
  val firstTileFocus = sections.firstOrNull()?.titles?.firstOrNull()?.let { requester(it.focusKey()) }

  fun submitSearch() {
    val submitted = query.trim()
    if (submitted.isNotEmpty()) onSearchText(submitted)
  }

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

  LaunchedEffect(person?.name) {
    val name = person?.name
    if (!name.isNullOrBlank() && query == args.name) query = name
  }

  LaunchedEffect(failure) {
    if (failure == null) return@LaunchedEffect
    awaitFrame()
    runCatching { retryFocus.requestFocus() }
  }

  fun open(title: PersonTitleDto) {
    if (openingKey != null) return
    val key = title.focusKey()
    notice = null
    when {
      title.id.startsWith("tt") -> onOpenTitle(title.related(title.id), key, false)
      title.id.startsWith("tmdb:") -> {
        openingKey = key
        scope.launch {
          try {
            val resolved = api.personTitle(title.type, title.tmdbId)
            onOpenTitle(title.related(resolved.id), key, resolved.imdb == "none")
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
    modifier = Modifier
      .fillMaxSize()
      .background(Tokens.Bg)
      .testTag(TagPersonScreen)
      .padding(start = Tokens.SafeX, top = Tokens.SafeY, end = Tokens.SafeX),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    args.fromTitle?.takeIf { it.isNotBlank() }?.let { title ->
      Text(
        stringResource(R.string.person_back_to, title),
        color = Tokens.Muted,
        fontSize = 11.sp,
      )
    }
    TvTextField(
      label = stringResource(R.string.tv_global_search_title),
      value = query,
      onValueChange = { query = it },
      imeAction = ImeAction.Done,
      surfaceRequester = fieldFocus,
      testTag = TagPersonSearchField,
      inputTestTag = TagPersonSearchInput,
      onSubmit = ::submitSearch,
      modifier = Modifier
        .fillMaxWidth()
        .then(if (firstTileFocus != null) Modifier.focusProperties { down = firstTileFocus } else Modifier),
    )
    when {
      person == null && failure == null -> {
        Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
          Text(stringResource(R.string.person_loading), color = Tokens.Muted, fontSize = 13.sp)
        }
      }
      failure != null -> {
        Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
          Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(14.dp),
          ) {
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
        val loaded = person!!
        PersonCard(
          person = loaded,
          imageUrl = imageUrl,
          onSearchText = onSearchText,
        )
        notice?.let {
          Text(
            apiErrorText(it),
            color = Tokens.Red,
            fontSize = 12.sp,
            modifier = Modifier.padding(horizontal = CardRowInset, vertical = 4.dp),
          )
        }
        if (sections.all { it.titles.isEmpty() }) {
          Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
            Text(stringResource(R.string.person_empty), color = Tokens.Muted, fontSize = 13.sp)
          }
        } else {
          PersonGrid(
            sections = sections,
            focusKey = args.focusKey,
            imageUrl = imageUrl,
            openingKey = openingKey,
            firstRowUp = fieldFocus,
            requester = ::requester,
            onOpen = ::open,
            modifier = Modifier.fillMaxWidth().weight(1f),
          )
        }
      }
    }
  }
}

@Composable
private fun PersonCard(
  person: PersonFilmographyDto,
  imageUrl: (String?) -> String?,
  onSearchText: (String) -> Unit,
) {
  Row(
    modifier = Modifier.fillMaxWidth().padding(horizontal = CardRowInset, vertical = 4.dp),
    horizontalArrangement = Arrangement.spacedBy(14.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(
      modifier = Modifier
        .size(64.dp)
        .clip(CircleShape)
        .background(Tokens.Panel2),
    ) {
      imageUrl(person.photo)?.let { art ->
        AsyncImage(
          model = art,
          contentDescription = stringResource(R.string.person_label, person.name),
          imageLoader = sessionImageLoader(),
          contentScale = ContentScale.Crop,
          modifier = Modifier.fillMaxSize(),
        )
      }
    }
    Column(
      modifier = Modifier.weight(1f),
      verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
      Text(
        person.name,
        color = Tokens.Text,
        fontSize = 15.sp,
        fontWeight = FontWeight.Bold,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      val section = stringResource(
        if (person.knownFor == "acting") R.string.person_acting else R.string.person_crew,
      )
      Text(
        "$section · ${pluralStringResource(R.plurals.person_title_count, person.total, person.total)}",
        color = Tokens.Muted,
        fontSize = 11.sp,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }
    FocusButton(
      text = stringResource(R.string.person_search_as_text, person.name),
      onClick = { onSearchText(person.name) },
      labelMaxWidth = 260.dp,
      modifier = Modifier.testTag(TagPersonSearchAsText),
    )
  }
}

@Composable
private fun PersonGrid(
  sections: List<PersonSectionDto>,
  focusKey: String?,
  imageUrl: (String?) -> String?,
  openingKey: String?,
  firstRowUp: FocusRequester,
  requester: (String) -> FocusRequester,
  onOpen: (PersonTitleDto) -> Unit,
  modifier: Modifier = Modifier,
) {
  BoxWithConstraints(modifier) {
    val columns = (((maxWidth.value + 18f) / 138f).toInt()).coerceAtLeast(1)
    val state = rememberLazyGridState()
    val focusTarget = focusTarget(sections, focusKey)
    LaunchedEffect(sections, focusKey) {
      val target = focusTarget ?: return@LaunchedEffect
      state.scrollToItem(target.second)
      awaitFrame()
      runCatching { requester(target.first.focusKey()).requestFocus() }
    }
    LazyVerticalGrid(
      columns = GridCells.Fixed(columns),
      state = state,
      modifier = Modifier.fillMaxSize().focusGroup(),
      contentPadding = PaddingValues(start = CardRowInset, top = 10.dp, end = CardRowInset, bottom = 40.dp),
      horizontalArrangement = Arrangement.spacedBy(18.dp),
      verticalArrangement = Arrangement.spacedBy(14.dp),
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
          GlobalSearchCard(
            title = title.name,
            imageUrl = imageUrl(title.poster ?: title.background),
            captionLines = if (openingKey == key) {
              listOf(stringResource(R.string.person_opening))
            } else {
              titleCaptions(title)
            },
            tag = personTileTag(title),
            onFocus = {},
            onClick = { onOpen(title) },
            modifier = Modifier
              .focusRequester(requester(key))
              .then(if (index < columns) Modifier.focusProperties { up = firstRowUp } else Modifier)
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

private fun focusTarget(sections: List<PersonSectionDto>, focusKey: String?): Pair<PersonTitleDto, Int>? {
  var first: Pair<PersonTitleDto, Int>? = null
  var itemIndex = 0
  for (section in sections) {
    itemIndex++
    section.titles.forEachIndexed { index, title ->
      val target = title to itemIndex + index
      if (first == null) first = target
      if (title.focusKey() == focusKey) return target
    }
    itemIndex += section.titles.size
  }
  return first
}

@Composable
private fun titleCaptions(title: PersonTitleDto): List<String> = listOfNotNull(
  title.year?.takeIf { it.isNotBlank() },
  stringResource(if (title.type == "series") R.string.person_series else R.string.person_movie),
  title.jobs.mapNotNull { jobLabel(it) }.takeIf { it.isNotEmpty() }?.joinToString(" · "),
  title.character?.takeIf { it.isNotBlank() },
  stringResource(R.string.person_in_library).takeIf { title.inLibrary },
)

@Composable
private fun jobLabel(job: String): String? = when (job) {
  "director" -> stringResource(R.string.detail_role_director)
  "writer" -> stringResource(R.string.detail_role_writer)
  "creator" -> stringResource(R.string.detail_role_creator)
  "novel" -> stringResource(R.string.detail_role_novel)
  else -> null
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
