package cz.stremiooffline.tv.ui.detail

import android.content.Intent
import android.net.Uri
import android.os.Build
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
import androidx.compose.foundation.layout.aspectRatio
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
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
import cz.stremiooffline.tv.catalog.Languages
import cz.stremiooffline.tv.catalog.Streams
import cz.stremiooffline.tv.data.LibraryTitleDto
import cz.stremiooffline.tv.data.RelatedTitleDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.TitleExtrasDto
import cz.stremiooffline.tv.data.TitlePersonDto
import cz.stremiooffline.tv.data.TitleVideoDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.episodeCode
import cz.stremiooffline.tv.ui.components.CardRowInset
import cz.stremiooffline.tv.ui.catalog.formatSize
import cz.stremiooffline.tv.ui.catalog.sourceGroupName
import cz.stremiooffline.tv.ui.theme.Tokens
import java.text.DateFormat
import java.text.NumberFormat
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
const val TagTitleExtrasRatings = "title_extras_ratings"
const val TagTitleExtrasImdb = "title_extras_imdb"
const val TagTitleExtrasTmdb = "title_extras_tmdb"
const val TagTitleExtrasVideos = "title_extras_videos"
const val TagTitleTech = "title_tech"

fun titlePersonTag(name: String): String = "title_person_$name"
fun relatedTitleTag(id: String): String = "related_title_$id"
fun videoCardTag(key: String): String = "title_video_$key"

/** Who made it first, then the cast, then the writers: one strip for everybody. */
private val StripOrder = listOf("creator", "director", "cast", "writer", "novel")

class TitleExtrasState {
  var extras by mutableStateOf<TitleExtrasDto?>(null)
  var loading by mutableStateOf(false)
  val scroll = ScrollState(0)
  val castFocus = FocusRequester()
  val videoFocus = FocusRequester()
  val relatedFocus = FocusRequester()
  var restoreRelatedId: String? = null
  private var videosResolved by mutableStateOf<Boolean?>(null)

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
      videosResolved == true -> videoFocus
      extras?.related.orEmpty().isNotEmpty() -> relatedFocus
      else -> return false
    }
    return runCatching { target.requestFocus() }.isSuccess
  }

  fun videosShown(resolver: (String) -> Boolean): Boolean {
    videosResolved?.let { return it }
    val shown = extras?.videos.orEmpty().any { video -> video.key.isNotBlank() && resolver(video.key) }
    videosResolved = shown
    return shown
  }

  fun clear() {
    request++
    key = null
    extras = null
    videosResolved = null
    loading = false
  }

  suspend fun load(api: TvApi, type: String, id: String, language: String?) {
    load(type, id) { api.titleExtras(type, id, language) }
  }

  suspend fun load(type: String, id: String, fetch: suspend () -> TitleExtrasDto?) {
    val nextKey = "$type:$id"
    // Only a finished answer is reused: a load that was cancelled midway (the remote detail
    // relaunches once its metadata resolves) leaves `loading` set and must not block the next one.
    if (key == nextKey && extras != null) return
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
      videosResolved = null
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
  imdbFallback: String? = null,
) {
  val uiLocale = LocalConfiguration.current.locales[0]
  val extras = state.extras
  if (extras == null) {
    if (metaLine.isNotBlank()) {
      Text(metaLine, color = Tokens.Muted, fontSize = 11.5.sp, fontWeight = FontWeight.Medium, modifier = modifier)
    }
    return
  }
  val age = extras.ageRating?.trim()?.takeIf { it.isNotEmpty() }
  val originalTitle = extras.originalTitle?.trim()?.takeIf { it.isNotEmpty() }
  val titleDiffers = originalTitle != null && !originalTitle.equals(name.trim(), ignoreCase = true)
  val imdb = extras.ratings.imdb?.trim()?.takeIf { it.isNotEmpty() }
    ?: imdbFallback?.trim()?.takeIf { it.isNotEmpty() }
  val tmdb = extras.ratings.tmdb
  val factsLine = if (imdb != null) {
    metaLine.split(" · ").filterNot { it.startsWith("★") }.joinToString(" · ")
  } else {
    metaLine
  }
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
    if (titleDiffers) {
      Text(
        stringResource(R.string.detail_original_title, originalTitle.orEmpty()),
        color = Tokens.Muted,
        fontSize = 10.5.sp,
      )
    }
    if (factsLine.isNotBlank()) {
      Text(factsLine, color = Tokens.Muted, fontSize = 11.5.sp, fontWeight = FontWeight.Medium)
    }
    if (age != null || imdb != null || tmdb != null) {
      RatingsRow(age = age, imdb = imdb, tmdb = tmdb, tmdbVotes = extras.ratings.tmdbVotes, locale = uiLocale)
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
private fun RatingsRow(
  age: String?,
  imdb: String?,
  tmdb: Double?,
  tmdbVotes: Long?,
  locale: Locale,
) {
  Row(
    modifier = Modifier.testTag(TagTitleExtrasRatings),
    horizontalArrangement = Arrangement.spacedBy(6.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
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
          .border(1.dp, Tokens.Muted.copy(alpha = 0.75f), RoundedCornerShape(5.dp))
          .padding(horizontal = 7.dp, vertical = 3.dp),
      )
    }
    imdb?.let { value ->
      RatingPill(
        label = "IMDb",
        value = ratingText(value, locale),
        labelColor = Color(0xFF111111),
        labelBackground = SolidColor(Tokens.Gold),
        modifier = Modifier.testTag(TagTitleExtrasImdb),
      )
    }
    tmdb?.let { value ->
      RatingPill(
        label = "TMDB",
        value = listOfNotNull(
          ratingText(value, locale),
          tmdbVotes?.takeIf { it > 0 }?.let { compactVotes(it, locale) },
        ).joinToString(" · "),
        labelColor = Color(0xFF0D253F),
        labelBackground = Brush.horizontalGradient(listOf(Color(0xFF90CEA1), Color(0xFF01B4E4))),
        modifier = Modifier.testTag(TagTitleExtrasTmdb),
      )
    }
  }
}

@Composable
private fun RatingPill(
  label: String,
  value: String,
  labelColor: Color,
  labelBackground: Brush,
  modifier: Modifier = Modifier,
) {
  val shape = RoundedCornerShape(5.dp)
  Row(
    modifier = modifier
      .border(1.dp, Color.White.copy(alpha = 0.12f), shape)
      .background(Color.White.copy(alpha = 0.06f), shape)
      .padding(4.dp),
    horizontalArrangement = Arrangement.spacedBy(6.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      label,
      color = labelColor,
      fontSize = 8.5.sp,
      fontWeight = FontWeight.Black,
      modifier = Modifier.background(labelBackground, shape).padding(horizontal = 5.dp, vertical = 2.dp),
    )
    Text(value, color = Tokens.Text, fontSize = 10.5.sp, fontWeight = FontWeight.ExtraBold)
  }
}

internal fun ratingText(value: String, locale: Locale): String {
  val number = value.trim().replace(',', '.').toDoubleOrNull() ?: return value
  return NumberFormat.getNumberInstance(locale).apply {
    minimumFractionDigits = 1
    maximumFractionDigits = 1
    isGroupingUsed = false
  }.format(number)
}

internal fun ratingText(value: Double, locale: Locale): String =
  NumberFormat.getNumberInstance(locale).apply {
    minimumFractionDigits = 1
    maximumFractionDigits = 1
    isGroupingUsed = false
  }.format(value)

private fun compactVotes(votes: Long, locale: Locale): String {
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
    runCatching {
      val style = Class.forName("java.text.NumberFormat\$Style")
      val short = style.enumConstants.orEmpty().first { (it as Enum<*>).name == "SHORT" }
      val method = NumberFormat::class.java.getMethod("getCompactNumberInstance", Locale::class.java, style)
      (method.invoke(null, locale, short) as NumberFormat).apply {
        maximumFractionDigits = 1
      }.format(votes)
    }.getOrNull()?.let { return it }
  }
  return NumberFormat.getIntegerInstance(locale).format(votes)
}

@Composable
fun TitleExtrasRows(
  state: TitleExtrasState,
  imageUrl: (String?) -> String?,
  onPerson: (String) -> Unit,
  onRelated: (RelatedTitleDto) -> Unit,
  onUpFromRows: () -> Unit,
  videoResolver: ((String) -> Boolean)? = null,
  onVideo: ((TitleVideoDto) -> Unit)? = null,
) {
  val extras = state.extras
  if (extras == null) {
    if (state.loading) TitleExtrasSkeleton()
    return
  }
  val context = LocalContext.current
  val resolver = videoResolver ?: { key ->
    context.packageManager.queryIntentActivities(videoIntent(key), 0).isNotEmpty()
  }
  val videosShown = state.videosShown(resolver)
  if (extras.people.isEmpty() && !videosShown && extras.related.isEmpty()) return

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
              if (event.type == KeyEventType.KeyDown) {
                when {
                  event.key == Key.DirectionUp -> {
                    onUpFromRows()
                    true
                  }
                  event.key == Key.DirectionDown && videosShown -> {
                    runCatching { state.videoFocus.requestFocus() }.isSuccess
                  }
                  else -> false
                }
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

    if (videosShown) {
      Text(
        stringResource(R.string.detail_videos),
        color = Tokens.Text,
        fontSize = 14.sp,
        fontWeight = FontWeight.Bold,
      )
      LazyRow(
        contentPadding = PaddingValues(horizontal = CardRowInset, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
        modifier = Modifier
          .testTag(TagTitleExtrasVideos)
          .onPreviewKeyEvent { event ->
            if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
            when (event.key) {
              Key.DirectionUp -> {
                if (cast.isNotEmpty()) {
                  runCatching { state.castFocus.requestFocus() }.isSuccess
                } else {
                  onUpFromRows()
                  true
                }
              }
              Key.DirectionDown -> extras.related.isNotEmpty() &&
                runCatching { state.relatedFocus.requestFocus() }.isSuccess
              else -> false
            }
          },
      ) {
        itemsIndexed(extras.videos, key = { index, video -> "${video.key}:$index" }) { index, video ->
          VideoCard(
            video = video,
            imageUrl = imageUrl(video.thumbnail),
            onClick = {
              val open = onVideo
              if (open != null) {
                open(video)
              } else {
                runCatching { context.startActivity(videoIntent(video.key)) }
              }
            },
            modifier = if (index == 0) Modifier.focusRequester(state.videoFocus) else Modifier,
          )
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
            if (event.type == KeyEventType.KeyDown && event.key == Key.DirectionUp) {
              when {
                videosShown -> runCatching { state.videoFocus.requestFocus() }.isSuccess
                cast.isNotEmpty() -> runCatching { state.castFocus.requestFocus() }.isSuccess
                else -> {
                  onUpFromRows()
                  true
                }
              }
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
fun TitleTechBlock(
  stream: StreamDto,
  modifier: Modifier = Modifier,
  uiLanguage: String? = null,
  titleLanguage: String? = null,
) {
  val locale = uiLanguage?.takeIf { it.isNotBlank() }?.let(::Locale) ?: LocalConfiguration.current.locales[0]
  val sourceName = sourceGroupName(stream)
    ?: stream.behaviorHints?.filename?.takeIf { Streams.isLocalStream(stream) && it.isNotBlank() }
    ?: stream.name?.takeIf { it.isNotBlank() }
  val source = listOfNotNull(sourceName, formatSize(Streams.streamSize(stream))).joinToString(" · ")
  val facts = stream.videoFacts
  val resolution = when {
    (facts?.heightPixels ?: 0) >= 2_000 -> "2160p"
    (facts?.heightPixels ?: 0) >= 1_000 -> "1080p"
    (facts?.heightPixels ?: 0) >= 700 -> "720p"
    else -> null
  }
  val videoTags = listOfNotNull(
    when (facts?.range) {
      "hdr" -> "HDR10"
      "dolbyVision" -> "Dolby Vision"
      else -> null
    },
    when (facts?.codec) {
      "h264" -> "H.264"
      "hevc" -> "HEVC"
      "av1" -> "AV1"
      else -> null
    },
  )
  val audioLanguages = (if (stream.audioLanguages.isNotEmpty()) {
    stream.audioLanguages
  } else {
    Streams.streamLanguages(stream, titleLanguage)
  }).map { languageName(it, locale) }.distinct()
  val audioTag = audioFormat(Streams.streamText(stream)).takeIf { it.isNotEmpty() }
  val subtitles = stream.subtitleLanguages.map { languageName(it, locale) }.distinct()
  val rows = listOf(
    source.takeIf { it.isNotBlank() },
    resolution,
    audioLanguages.takeIf { it.isNotEmpty() }.then(audioTag),
    subtitles.takeIf { it.isNotEmpty() },
  )
  if (rows.all { it == null }) return

  Column(
    modifier
      .semantics(mergeDescendants = true) {}
      .testTag(TagTitleTech),
    verticalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    source.takeIf { it.isNotBlank() }?.let {
      TechRow(stringResource(R.string.detail_will_play), it)
    }
    if (resolution != null || videoTags.isNotEmpty()) {
      TechRow(stringResource(R.string.detail_tech_video), resolution.orEmpty(), videoTags)
    }
    if (audioLanguages.isNotEmpty() || audioTag != null) {
      TechRow(stringResource(R.string.detail_tech_audio), audioLanguages.joinToString(", "), listOfNotNull(audioTag))
    }
    if (subtitles.isNotEmpty()) {
      TechRow(stringResource(R.string.detail_tech_subtitles), subtitles.joinToString(", "))
    }
  }
}

@Composable
private fun TechRow(label: String, value: String, tags: List<String> = emptyList()) {
  Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
    Text(
      label,
      color = Tokens.Muted,
      fontSize = 10.sp,
      fontWeight = FontWeight.Bold,
      modifier = Modifier.width(82.dp),
    )
    Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
      if (value.isNotEmpty()) Text(value, color = Tokens.Text.copy(alpha = 0.88f), fontSize = 10.5.sp)
      tags.forEach { tag ->
        Text(
          tag,
          color = Tokens.Text,
          fontSize = 8.5.sp,
          fontWeight = FontWeight.Black,
          modifier = Modifier
            .clip(RoundedCornerShape(4.dp))
            .background(Tokens.Panel2)
            .padding(horizontal = 5.dp, vertical = 2.dp),
        )
      }
    }
  }
}

private fun List<String>?.then(tag: String?): List<String>? =
  if (this.isNullOrEmpty() && tag == null) null else this.orEmpty() + listOfNotNull(tag)

private fun languageName(code: String, locale: Locale): String {
  val trimmed = code.trim()
  if (trimmed.isBlank()) return ""
  if (trimmed.length !in 2..3) return trimmed
  return runCatching { Locale(trimmed).getDisplayLanguage(locale) }
    .getOrNull()
    ?.takeIf { it.isNotBlank() && it != trimmed }
    ?.replaceFirstChar { if (it.isLowerCase()) it.titlecase(locale) else it.toString() }
    ?: trimmed.uppercase(locale)
}

internal fun audioFormat(text: String): String {
  val channels = Regex("(?<!\\d)(7[.,]1|5[.,]1|2[.,]0)(?!\\d)")
    .find(text)
    ?.groupValues
    ?.get(1)
    ?.replace(',', '.')
  val normalized = text.lowercase(Locale.US)
    .replace(Regex("[._-]+"), " ")
    .replace(Regex("\\s+"), " ")
  val compact = normalized.replace(" ", "")
  val format = when {
    "atmos" in compact -> "Atmos"
    "truehd" in compact -> "TrueHD"
    "dtshdma" in compact -> "DTS-HD MA"
    "dtshd" in compact -> "DTS-HD"
    Regex("\\bdts\\b").containsMatchIn(normalized) -> "DTS"
    "dd+" in compact || "ddp" in compact || "eac3" in compact -> "DD+"
    Regex("\\bdd\\b").containsMatchIn(normalized) || "dd5" in compact || "dd2" in compact -> "DD"
    "ac3" in compact -> "DD"
    "aac" in compact -> "AAC"
    "flac" in compact -> "FLAC"
    "opus" in compact -> "Opus"
    else -> null
  }
  return listOfNotNull(format, channels).joinToString(" ")
}

internal fun videoIntent(key: String): Intent =
  Intent(Intent.ACTION_VIEW, Uri.parse("https://www.youtube.com/watch?v=$key"))

@Composable
private fun VideoCard(
  video: TitleVideoDto,
  imageUrl: String?,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  var focused by remember { mutableStateOf(false) }
  var failed by remember(imageUrl) { mutableStateOf(false) }
  val scale by animateFloatAsState(if (focused) 1.06f else 1f, label = "video-card-scale")
  val shape = RoundedCornerShape(10.dp)
  Column(Modifier.width(168.dp)) {
    Surface(
      onClick = onClick,
      modifier = modifier
        .width(168.dp)
        .aspectRatio(16f / 9f)
        .graphicsLayer {
          scaleX = scale
          scaleY = scale
          transformOrigin = TransformOrigin(0.5f, 0f)
        }
        .testTag(videoCardTag(video.key))
        .onFocusChanged { focused = it.isFocused },
      shape = ClickableSurfaceDefaults.shape(shape),
      scale = ClickableSurfaceDefaults.scale(focusedScale = 1f),
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
      Box(Modifier.fillMaxSize().background(Tokens.Panel2)) {
        if (imageUrl != null && !failed) {
          AsyncImage(
            model = imageUrl,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            onError = { failed = true },
            modifier = Modifier.fillMaxSize(),
          )
        }
        if (imageUrl == null || failed) {
          Text(
            video.name,
            color = Tokens.Text,
            fontSize = 10.5.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.align(Alignment.Center).padding(8.dp),
          )
        }
      }
    }
    Spacer(Modifier.height(7.dp))
    Text(
      video.name,
      color = if (focused) Tokens.Text else Tokens.Text.copy(alpha = 0.82f),
      fontSize = 10.5.sp,
      fontWeight = FontWeight.SemiBold,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.fillMaxWidth(),
    )
    Text(
      videoKindLabel(video.kind),
      color = Tokens.Muted,
      fontSize = 9.5.sp,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.fillMaxWidth(),
    )
  }
}

@Composable
private fun videoKindLabel(kind: String): String = when (kind) {
  "trailer" -> stringResource(R.string.detail_video_trailer)
  "teaser" -> stringResource(R.string.detail_video_teaser)
  "clip" -> stringResource(R.string.detail_video_clip)
  "featurette" -> stringResource(R.string.detail_video_featurette)
  "behindTheScenes" -> stringResource(R.string.detail_video_behind_the_scenes)
  else -> kind
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
      // The card scales itself from its top edge; the Surface's own centred focus scale on top of
      // that grew it down over its caption.
      scale = ClickableSurfaceDefaults.scale(focusedScale = 1f),
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
      lineHeight = 13.sp,
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
      // The card scales itself from its top edge; the Surface's own centred focus scale on top of
      // that grew it down over its caption.
      scale = ClickableSurfaceDefaults.scale(focusedScale = 1f),
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
