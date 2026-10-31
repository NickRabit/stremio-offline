package cz.stremiooffline.tv.ui.detail

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Glow
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import coil.compose.AsyncImage
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.LibraryTitleDto
import cz.stremiooffline.tv.data.RelatedTitleDto
import cz.stremiooffline.tv.data.TitleExtrasDto
import cz.stremiooffline.tv.data.TitlePersonDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.episodeCode
import cz.stremiooffline.tv.ui.components.CardRowInset
import cz.stremiooffline.tv.ui.theme.Tokens
import java.text.DateFormat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.android.awaitFrame
import kotlinx.coroutines.delay

const val TagTitleExtrasCast = "title_extras_cast"
const val TagTitleExtrasRelated = "title_extras_related"
const val TagTitleExtrasSkeleton = "title_extras_skeleton"
const val TagTitleExtrasAge = "title_extras_age"
const val TagTitleExtrasNextEpisode = "title_extras_next_episode"

fun titlePersonTag(name: String): String = "title_person_$name"
fun relatedTitleTag(id: String): String = "related_title_$id"

/** Who made it first, then the cast, then the writers: one strip for everybody. */
private val StripOrder = listOf("creator", "director", "cast", "writer", "novel")

class TitleExtrasState {
  var extras by mutableStateOf<TitleExtrasDto?>(null)
  var loading by mutableStateOf(false)
  val scroll = ScrollState(0)
  val castFocus = FocusRequester()
  val relatedFocus = FocusRequester()
  var restoreRelatedId: String? = null

  private var key: String? = null
  private var request = 0
  private var libraryPath: String? = null
  private var libraryReady = false
  private var libraryValue: LibraryTitleDto? = null

  val cast: List<TitlePersonDto> get() = extras?.people.orEmpty().let { people ->
    StripOrder.flatMap { role -> people.filter { it.role.equals(role, ignoreCase = true) } }
  }

  fun focusFirst(): Boolean {
    val target = when {
      cast.isNotEmpty() -> castFocus
      extras?.related.orEmpty().isNotEmpty() -> relatedFocus
      else -> return false
    }
    return runCatching { target.requestFocus() }.isSuccess
  }

  fun clear() {
    request++
    key = null
    extras = null
    loading = false
  }

  suspend fun load(api: TvApi, type: String, id: String, language: String?) {
    load(type, id) { api.titleExtras(type, id, language) }
  }

  suspend fun load(type: String, id: String, fetch: suspend () -> TitleExtrasDto?) {
    val nextKey = "$type:$id"
    if (key == nextKey && (loading || extras != null)) return
    val current = begin(nextKey)
    val loaded = try {
      fetch()
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: Exception) {
      null
    }
    if (current != request || key != nextKey) return
    extras = loaded
    loading = false
  }

  suspend fun loadLibrary(api: TvApi, path: String?, language: String?) {
    val nextKey = "library:${path.orEmpty()}"
    val current = begin(nextKey)
    if (path.isNullOrBlank()) {
      if (current == request && key == nextKey) loading = false
      return
    }
    val binding = try {
      api.libraryTitle(path)
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: Exception) {
      null
    }
    if (current != request || key != nextKey) return
    libraryPath = path
    libraryValue = binding
    libraryReady = true
    if (binding == null || binding.type.isBlank() || binding.id.isBlank()) {
      extras = null
      loading = false
      return
    }
    load(binding.type, binding.id) { api.titleExtras(binding.type, binding.id, language) }
  }

  internal fun hasLibraryTitle(path: String): Boolean = libraryReady && libraryPath == path

  internal fun cachedLibraryTitle(path: String): LibraryTitleDto? =
    libraryValue.takeIf { hasLibraryTitle(path) }

  internal suspend fun loadRemote(
    metadata: RemoteMetadata,
    loadExtras: (suspend (type: String, id: String) -> TitleExtrasDto)?,
  ) {
    val identity = remoteExtrasIdentity(metadata)
    if (loadExtras == null || identity == null) {
      clear()
      return
    }
    load(identity.first, identity.second) { loadExtras(identity.first, identity.second) }
  }

  private fun begin(nextKey: String): Int {
    if (key != nextKey) {
      key = nextKey
      extras = null
    }
    loading = true
    return ++request
  }
}

internal fun remoteExtrasIdentity(metadata: RemoteMetadata): Pair<String, String>? {
  val type = when (metadata.item.type) {
    "movie" -> "movie"
    "series", "episode", "season" -> "series"
    else -> return null
  }
  val ids = if (metadata.item.type == "episode" || metadata.item.type == "season") {
    metadata.seriesIds
  } else {
    metadata.item.providerIds
  }
  val imdb = ids?.imdb?.trim()?.takeIf { it.startsWith("tt", ignoreCase = true) && it.length > 2 }
  val tmdb = ids?.tmdb?.trim()?.takeIf { it.isNotEmpty() }
  return when {
    imdb != null -> type to imdb
    tmdb != null -> type to "tmdb:$tmdb"
    else -> null
  }
}

@Composable
fun TitleExtraFacts(
  state: TitleExtrasState,
  name: String,
  metaLine: String,
  uiLanguage: String?,
  modifier: Modifier = Modifier,
  clock: () -> Long = System::currentTimeMillis,
) {
  val extras = state.extras ?: return
  val uiLocale = LocalConfiguration.current.locales[0]
  val age = extras.ageRating?.trim()?.takeIf { it.isNotEmpty() }
  val originalTitle = extras.originalTitle?.trim()?.takeIf { it.isNotEmpty() }
  val titleDiffers = originalTitle != null && !originalTitle.equals(name.trim(), ignoreCase = true)
  val originalLanguage = extras.originalLanguage?.trim()?.takeIf { it.isNotEmpty() }
  val languageDiffers = originalLanguage != null && languageCode(originalLanguage) != languageCode(uiLanguage ?: uiLocale.language)
  val languageName = originalLanguage?.takeIf { languageDiffers }?.let { Locale(it).getDisplayLanguage(uiLocale) }
  val release = parseReleaseTime(extras.nextEpisode?.released)
  var nowMillis by remember { mutableLongStateOf(clock()) }
  val nextEpisodeShown = release != null && release > nowMillis

  LaunchedEffect(extras.nextEpisode?.released, nextEpisodeShown) {
    while (nextEpisodeShown) {
      delay(60_000)
      nowMillis = clock()
    }
  }

  Column(modifier, verticalArrangement = Arrangement.spacedBy(5.dp)) {
    if (metaLine.isNotBlank() || age != null) {
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        if (metaLine.isNotBlank()) {
          Text(metaLine, color = Tokens.Muted, fontSize = 11.5.sp, fontWeight = FontWeight.Medium)
        }
        age?.let { rating ->
          val label = stringResource(R.string.detail_age_rating, rating)
          Text(
            rating,
            color = Tokens.Text,
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier
              .testTag(TagTitleExtrasAge)
              .semantics { contentDescription = label }
              .border(1.dp, Tokens.Muted, RoundedCornerShape(4.dp))
              .padding(horizontal = 6.dp, vertical = 2.dp),
          )
        }
      }
    }
    if (titleDiffers) {
      Text(
        stringResource(R.string.detail_original_title, originalTitle.orEmpty()),
        color = Tokens.Muted,
        fontSize = 10.5.sp,
      )
    }
    if (languageDiffers) {
      Text(
        stringResource(R.string.detail_original_language, languageName.orEmpty()),
        color = Tokens.Muted,
        fontSize = 10.5.sp,
      )
    }
    if (nextEpisodeShown) {
      val next = extras.nextEpisode ?: return@Column
      val episode = listOfNotNull(
        episodeCode(next.season, next.episode),
        next.name?.trim()?.takeIf { it.isNotEmpty() },
      ).joinToString(" · ")
      val released = DateFormat.getDateInstance(DateFormat.MEDIUM, uiLocale).format(Date(release))
      Text(
        stringResource(R.string.detail_next_episode, episode, released),
        color = Tokens.Text,
        fontSize = 10.5.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier
          .testTag(TagTitleExtrasNextEpisode)
          .clip(RoundedCornerShape(999.dp))
          .background(Tokens.Panel2)
          .border(1.dp, Tokens.Line, RoundedCornerShape(999.dp))
          .padding(horizontal = 10.dp, vertical = 4.dp),
      )
    }
  }
}

@Composable
fun TitleExtrasRows(
  state: TitleExtrasState,
  imageUrl: (String?) -> String?,
  onPerson: (String) -> Unit,
  onRelated: (RelatedTitleDto) -> Unit,
  onUpFromRows: () -> Unit,
) {
  val extras = state.extras
  if (extras == null) {
    if (state.loading) TitleExtrasSkeleton()
    return
  }
  if (extras.people.isEmpty() && extras.related.isEmpty()) return

  val crewLabels = mapOf(
    "creator" to stringResource(R.string.detail_role_creator),
    "director" to stringResource(R.string.detail_role_director),
    "writer" to stringResource(R.string.detail_role_writer),
    "novel" to stringResource(R.string.detail_role_novel),
  )
  // A crew member carries the role where a cast member carries the character.
  val cast = state.cast.map { person ->
    crewLabels[person.role.lowercase()]?.let { person.copy(character = it) } ?: person
  }
  val relatedState = rememberLazyListState()

  LaunchedEffect(extras.related, state.restoreRelatedId) {
    val wanted = state.restoreRelatedId ?: return@LaunchedEffect
    val index = extras.related.indexOfFirst { it.id == wanted }
    if (index >= 0) {
      relatedState.scrollToItem(index)
      awaitFrame()
      runCatching { state.relatedFocus.requestFocus() }
    }
    state.restoreRelatedId = null
  }

  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    if (cast.isNotEmpty()) {
      Text(
        stringResource(R.string.detail_people),
        color = Tokens.Text,
        fontSize = 14.sp,
        fontWeight = FontWeight.Bold,
      )
      if (cast.isNotEmpty()) {
        Text(
          stringResource(R.string.detail_people_hint_tv),
          color = Tokens.Muted,
          fontSize = 9.5.sp,
        )
      }
      if (cast.isNotEmpty()) {
        LazyRow(
          contentPadding = PaddingValues(horizontal = CardRowInset, vertical = 8.dp),
          horizontalArrangement = Arrangement.spacedBy(16.dp),
          modifier = Modifier
            .testTag(TagTitleExtrasCast)
            .onPreviewKeyEvent { event ->
              if (event.type == KeyEventType.KeyDown && event.key == Key.DirectionUp) {
                onUpFromRows()
                true
              } else {
                false
              }
            },
        ) {
          itemsIndexed(cast, key = { index, person -> "${person.name}:$index" }) { index, person ->
            PersonCard(
              person = person,
              imageUrl = imageUrl(person.photo),
              onClick = { onPerson(person.name) },
              modifier = if (index == 0) Modifier.focusRequester(state.castFocus) else Modifier,
            )
          }
        }
      }
    }

    if (extras.related.isNotEmpty()) {
      Text(
        stringResource(R.string.detail_related),
        color = Tokens.Text,
        fontSize = 14.sp,
        fontWeight = FontWeight.Bold,
      )
      LazyRow(
        state = relatedState,
        contentPadding = PaddingValues(horizontal = CardRowInset, vertical = 18.dp),
        horizontalArrangement = Arrangement.spacedBy(20.dp),
        modifier = Modifier
          .testTag(TagTitleExtrasRelated)
          .onPreviewKeyEvent { event ->
            if (cast.isEmpty() && event.type == KeyEventType.KeyDown && event.key == Key.DirectionUp) {
              onUpFromRows()
              true
            } else {
              false
            }
          },
      ) {
        itemsIndexed(extras.related, key = { index, title -> "${title.type}:${title.id}:$index" }) { index, title ->
          val restore = state.restoreRelatedId == title.id
          RelatedCard(
            title = title,
            imageUrl = imageUrl(title.poster),
            onClick = { onRelated(title) },
            modifier = if (restore || (state.restoreRelatedId == null && index == 0)) {
              Modifier.focusRequester(state.relatedFocus)
            } else {
              Modifier
            },
          )
        }
      }
    }
  }
}

fun Modifier.downIntoExtras(state: TitleExtrasState): Modifier = onPreviewKeyEvent { event ->
  event.type == KeyEventType.KeyDown && event.key == Key.DirectionDown && state.focusFirst()
}

@Composable
fun ChosenSourceCaption(
  caption: String,
  sourceModifier: Modifier = Modifier,
) {
  Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
    Text(
      stringResource(R.string.detail_will_play).uppercase(),
      color = Tokens.Accent,
      fontSize = 9.5.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 1.sp,
    )
    Text(
      caption,
      color = Tokens.Text.copy(alpha = 0.82f),
      fontSize = 11.sp,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      modifier = sourceModifier,
    )
  }
}

@Composable
private fun PersonCard(
  person: TitlePersonDto,
  imageUrl: String?,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  var focused by remember { mutableStateOf(false) }
  var failed by remember(imageUrl) { mutableStateOf(false) }
  val scale by animateFloatAsState(if (focused) 1.08f else 1f, label = "person-card-scale")
  Column(
    modifier = Modifier.width(82.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Surface(
      onClick = onClick,
      modifier = modifier
        .size(58.dp)
        .graphicsLayer {
          scaleX = scale
          scaleY = scale
          transformOrigin = TransformOrigin(0.5f, 0f)
        }
        .testTag(titlePersonTag(person.name))
        .onFocusChanged { focused = it.isFocused },
      shape = ClickableSurfaceDefaults.shape(CircleShape),
      glow = ClickableSurfaceDefaults.glow(focusedGlow = Glow(Color.White.copy(alpha = 0.28f), 18.dp)),
      border = ClickableSurfaceDefaults.border(
        border = Border.None,
        focusedBorder = Border(BorderStroke(2.dp, Color.White), shape = CircleShape),
      ),
      colors = ClickableSurfaceDefaults.colors(
        containerColor = Tokens.Panel2,
        focusedContainerColor = Tokens.Panel2,
      ),
    ) {
      Box(Modifier.fillMaxSize().background(Tokens.Panel2), contentAlignment = Alignment.Center) {
        if (imageUrl != null && !failed) {
          AsyncImage(
            model = imageUrl,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            onError = { failed = true },
            modifier = Modifier.fillMaxSize(),
          )
        } else {
          Text(
            initials(person.name),
            color = Tokens.Text,
            fontSize = 15.sp,
            fontWeight = FontWeight.ExtraBold,
          )
        }
      }
    }
    Spacer(Modifier.height(6.dp))
    Text(
      person.name,
      color = if (focused) Tokens.Text else Tokens.Text.copy(alpha = 0.82f),
      fontSize = 10.5.sp,
      fontWeight = FontWeight.SemiBold,
      textAlign = TextAlign.Center,
      maxLines = 2,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.fillMaxWidth(),
    )
    person.character?.trim()?.takeIf { it.isNotEmpty() }?.let { character ->
      Text(
        character,
        color = Tokens.Muted,
        fontSize = 9.5.sp,
        textAlign = TextAlign.Center,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.fillMaxWidth(),
      )
    }
  }
}

@Composable
private fun RelatedCard(
  title: RelatedTitleDto,
  imageUrl: String?,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  var focused by remember { mutableStateOf(false) }
  val scale by animateFloatAsState(if (focused) 1.06f else 1f, label = "related-card-scale")
  val shape = RoundedCornerShape(10.dp)
  val libraryLabel = stringResource(R.string.detail_in_library)
  Column(Modifier.width(110.dp)) {
    Surface(
      onClick = onClick,
      modifier = modifier
        .width(110.dp)
        .height(165.dp)
        .graphicsLayer {
          scaleX = scale
          scaleY = scale
          transformOrigin = TransformOrigin(0.5f, 0f)
        }
        .testTag(relatedTitleTag(title.id))
        .onFocusChanged { focused = it.isFocused },
      shape = ClickableSurfaceDefaults.shape(shape),
      glow = ClickableSurfaceDefaults.glow(focusedGlow = Glow(Color.White.copy(alpha = 0.28f), 18.dp)),
      border = ClickableSurfaceDefaults.border(
        border = Border.None,
        focusedBorder = Border(BorderStroke(2.dp, Color.White), shape = shape),
      ),
      colors = ClickableSurfaceDefaults.colors(
        containerColor = Tokens.Panel2,
        focusedContainerColor = Tokens.Panel2,
      ),
    ) {
      Box(Modifier.fillMaxSize()) {
        if (imageUrl != null) {
          AsyncImage(
            model = imageUrl,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize(),
          )
        } else {
          Text(
            title.name,
            color = Tokens.Text,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.align(Alignment.BottomStart).padding(8.dp),
          )
        }
      }
    }
    Spacer(Modifier.height(14.dp))
    Text(
      title.name,
      color = if (focused) Tokens.Text else Tokens.Text.copy(alpha = 0.82f),
      fontSize = 10.5.sp,
      fontWeight = FontWeight.SemiBold,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.fillMaxWidth(),
    )
    listOfNotNull(
      title.year?.trim()?.takeIf { it.isNotEmpty() }?.let { it to Tokens.Muted },
      if (title.inLibrary) libraryLabel to Tokens.Green else null,
    ).forEach { (line, colour) ->
      Text(
        line,
        color = colour,
        fontSize = 9.5.sp,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.fillMaxWidth(),
      )
    }
  }
}

@Composable
private fun TitleExtrasSkeleton() {
  Column(
    modifier = Modifier.testTag(TagTitleExtrasSkeleton),
    verticalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Box(Modifier.width(132.dp).height(14.dp).clip(RoundedCornerShape(4.dp)).background(Tokens.Panel2))
    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
      repeat(5) {
        Box(Modifier.size(58.dp).clip(CircleShape).background(Tokens.Panel2))
      }
    }
    Box(Modifier.width(116.dp).height(14.dp).clip(RoundedCornerShape(4.dp)).background(Tokens.Panel2))
    Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
      repeat(3) {
        Box(Modifier.width(110.dp).height(165.dp).clip(RoundedCornerShape(10.dp)).background(Tokens.Panel2))
      }
    }
  }
}

internal fun initials(name: String): String = name.trim().split(Regex("\\s+"))
  .filter { it.isNotEmpty() }
  .take(2)
  .mapNotNull { it.firstOrNull()?.uppercaseChar() }
  .joinToString("")

internal fun languageCode(value: String?): String =
  value.orEmpty().trim().substringBefore('-').substringBefore('_').lowercase(Locale.US)

internal fun parseReleaseTime(value: String?): Long? {
  val text = value?.trim()?.takeIf { it.isNotEmpty() } ?: return null
  return listOf("yyyy-MM-dd'T'HH:mm:ss.SSSX", "yyyy-MM-dd'T'HH:mm:ssX").firstNotNullOfOrNull { pattern ->
    runCatching { SimpleDateFormat(pattern, Locale.US).parse(text)?.time }.getOrNull()
  }
}
