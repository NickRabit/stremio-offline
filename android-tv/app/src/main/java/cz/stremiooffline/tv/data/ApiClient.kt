package cz.stremiooffline.tv.data

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/** Every way a call can fail, before it is turned into a catalogued message. */
enum class ApiFailure {
  Unreachable, Incompatible, BadCredentials, TooMany, NeedsSetup, MustChangePassword, SessionExpired,
  NotFound, Forbidden, Generic
}

class ApiError(val failure: ApiFailure, val seconds: Int? = null) : Exception(failure.name)

data class ServerStatus(val version: String)

data class LoginResult(val username: String, val mustChangePassword: Boolean)

sealed interface MeResult {
  data object Setup : MeResult
  data class SignedIn(val username: String, val language: String?) : MeResult
}

/** The typed API of one Stremio Offline server. No call retries on its own. */
class ApiClient(
  private val address: ServerAddress,
  cookieStore: CookieStore,
  baseClient: OkHttpClient = OkHttpClient(),
) : TvApi {

  private val json = Json { ignoreUnknownKeys = true }
  /** The download body drops null media fields instead of sending them as `null`. */
  private val downloadJson = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = false }
  /** Progress carries the artwork and addon only when the player knew them. */
  private val progressJson = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = false }
  private val mediaType = "application/json; charset=utf-8".toMediaType()

  private val client = baseClient.newBuilder()
    .connectTimeout(5, TimeUnit.SECONDS)
    .readTimeout(10, TimeUnit.SECONDS)
    .followRedirects(true)
    .cookieJar(cookieStore)
    .addNetworkInterceptor { chain ->
      val request = chain.request()
      if (address.isDowngrade(request.url)) throw IOException("Refusing to downgrade https to http")
      chain.proceed(request)
    }
    .build()

  /** The one HTTP client of the session: images and the player share it so they share the cookie. */
  override val http: OkHttpClient get() = client

  /** A server-relative address (an image, a stream) resolved against the configured prefix. */
  override fun url(path: String): String =
    if (path.startsWith("http://") || path.startsWith("https://")) path else address.resolve(path).toString()

  suspend fun status(): ServerStatus {
    call(Request.Builder().url(address.resolve("/api/status")).get().build()).closing { response ->
      val parsed = readBody(response).decodeOrNull<StatusResponse>()
      if (parsed?.status != "ok") throw ApiError(ApiFailure.Incompatible)
      return ServerStatus(parsed.version.orEmpty())
    }
  }

  suspend fun login(username: String, password: String): LoginResult {
    val payload = json.encodeToString(LoginRequest.serializer(), LoginRequest(username, password, true))
    call(Request.Builder().url(address.resolve("/api/auth/login")).post(payload.toRequestBody(mediaType)).build())
      .closing { response ->
        val body = readBody(response)
        return when {
          response.isSuccessful -> {
            val parsed = body.decodeOrNull<LoginResponse>() ?: throw ApiError(ApiFailure.Generic)
            LoginResult(parsed.username.orEmpty(), parsed.mustChangePassword)
          }
          response.code == 401 -> throw ApiError(
            if (body.decodeOrNull<ErrorBody>()?.messageKey == "err.badCredentials") ApiFailure.BadCredentials
            else ApiFailure.Generic
          )
          response.code == 429 -> throw ApiError(ApiFailure.TooMany, body.decodeOrNull<ErrorBody>()?.vars?.seconds)
          else -> throw ApiError(ApiFailure.Generic)
        }
      }
  }

  suspend fun me(): MeResult {
    call(Request.Builder().url(address.resolve("/api/auth/me")).get().build()).closing { response ->
      val body = readBody(response)
      if (response.code == 401) throw ApiError(ApiFailure.SessionExpired)
      val parsed = body.decodeOrNull<MeResponse>() ?: throw ApiError(ApiFailure.Incompatible)
      if (parsed.setup) return MeResult.Setup
      return MeResult.SignedIn(parsed.username ?: throw ApiError(ApiFailure.SessionExpired), parsed.language)
    }
  }

  override suspend fun settings(): SettingsResponse {
    call(Request.Builder().url(address.resolve("/api/settings")).get().build()).closing { response ->
      if (!response.isSuccessful) throw ApiError(ApiFailure.Generic)
      return readBody(response).decodeOrNull<SettingsResponse>() ?: SettingsResponse()
    }
  }

  suspend fun logout() {
    try {
      call(Request.Builder().url(address.resolve("/api/auth/logout")).post("{}".toRequestBody(mediaType)).build()).closing { }
    } catch (_: ApiError) {
    }
  }

  /** One page of the library tree. An unknown item kind is dropped rather than failing the page. */
  override suspend fun browse(path: String?, limit: Int, skip: Int): BrowseResult {
    val query = buildString {
      append("?limit=").append(limit).append("&skip=").append(skip)
      if (!path.isNullOrEmpty()) append("&path=").append(encode(path))
    }
    val page = request(Request.Builder().url(address.resolve("/api/library/browse$query")).get().build())
      .decode<BrowsePage>() ?: throw ApiError(ApiFailure.Generic)
    return BrowseResult(page.path, browseItems(page), page.total, page.pending)
  }

  /** Mints a playable source for one library file. */
  override suspend fun librarySource(path: String): SourceDto {
    val payload = json.encodeToString(SourceRequest.serializer(), SourceRequest(path))
    return request(Request.Builder().url(address.resolve("/api/library/source")).post(payload.toRequestBody(mediaType)).build())
      .decode<SourceDto>() ?: throw ApiError(ApiFailure.Generic)
  }

  /** One page of the library's Favourites view. */
  override suspend fun favorites(limit: Int, skip: Int): BrowseResult {
    val page = request(Request.Builder().url(address.resolve("/api/library/favorites?limit=$limit&skip=$skip")).get().build())
      .decode<BrowsePage>() ?: throw ApiError(ApiFailure.Generic)
    return BrowseResult(page.path, browseItems(page), page.total, page.pending)
  }

  /** Stars or unstars a library file or folder. */
  override suspend fun setFavorite(path: String, favorite: Boolean): FavoriteToggleDto {
    val payload = json.encodeToString(FavoriteRequest.serializer(), FavoriteRequest(path, favorite))
    return request(Request.Builder().url(address.resolve("/api/library/favorite")).post(payload.toRequestBody(mediaType)).build())
      .decode() ?: FavoriteToggleDto(path, favorite)
  }

  override suspend fun startPlayback(sourceId: String, capabilities: ClientCapabilitiesDto, time: Double): PlaybackDescriptorDto {
    val payload = json.encodeToString(
      PlaybackStartRequest.serializer(),
      PlaybackStartRequest(sourceId, capabilities, time),
    )
    return request(Request.Builder().url(address.resolve("/api/playback")).post(payload.toRequestBody(mediaType)).build())
      .decode<PlaybackDescriptorDto>() ?: throw ApiError(ApiFailure.Generic)
  }

  override suspend fun seekPlayback(id: String, time: Double): PlaybackDescriptorDto {
    val payload = json.encodeToString(TimeRequest.serializer(), TimeRequest(time))
    return request(Request.Builder().url(address.resolve("/api/playback/$id/seek")).post(payload.toRequestBody(mediaType)).build())
      .decode<PlaybackDescriptorDto>() ?: throw ApiError(ApiFailure.Generic)
  }

  override suspend fun escalatePlayback(id: String, time: Double): PlaybackDescriptorDto {
    val payload = json.encodeToString(TimeRequest.serializer(), TimeRequest(time))
    return request(Request.Builder().url(address.resolve("/api/playback/$id/escalate")).post(payload.toRequestBody(mediaType)).build())
      .decode<PlaybackDescriptorDto>() ?: throw ApiError(ApiFailure.Generic)
  }

  override suspend fun pingPlayback(id: String) {
    request(Request.Builder().url(address.resolve("/api/playback/$id/ping")).post("{}".toRequestBody(mediaType)).build())
  }

  override suspend fun deletePlayback(id: String) {
    request(Request.Builder().url(address.resolve("/api/playback/$id")).delete().build())
  }

  /** The stored position of one progress key, or null when nothing is stored. */
  override suspend fun progress(key: String): ProgressDto? {
    val body = request(Request.Builder().url(address.resolve("/api/progress/" + encode(key))).get().build())
    if (body.isBlank() || body == "null") return null
    return body.decode<ProgressDto>()
  }

  override suspend fun catalogs(): List<CatalogDto> =
    request(Request.Builder().url(address.resolve("/api/catalogs")).get().build()).decode() ?: emptyList()

  override suspend fun catalog(addonKey: String, type: String, id: String, skip: Int, genre: String?): List<MetaDto> {
    val query = buildString {
      append("?addon=").append(encode(addonKey))
      append("&type=").append(encode(type))
      append("&id=").append(encode(id))
      if (skip > 0) append("&skip=").append(skip)
      if (!genre.isNullOrEmpty()) append("&genre=").append(encode(genre))
    }
    return request(Request.Builder().url(address.resolve("/api/catalog$query")).get().build()).decode() ?: emptyList()
  }

  override suspend fun search(query: String, cursor: String?): SearchResultDto {
    val suffix = buildString {
      append("?query=").append(encode(query))
      if (!cursor.isNullOrEmpty()) append("&cursor=").append(encode(cursor))
    }
    return request(Request.Builder().url(address.resolve("/api/search$suffix")).get().build()).decode()
      ?: throw ApiError(ApiFailure.Generic)
  }

  override suspend fun meta(type: String, id: String, language: String?): MetaDto {
    val suffix = if (!language.isNullOrEmpty()) "?language=" + encode(language) else ""
    return request(Request.Builder().url(address.resolve("/api/meta/" + encode(type) + "/" + encode(id) + suffix)).get().build()).decode()
      ?: throw ApiError(ApiFailure.Generic)
  }

  /** The source addons of one video, in the caller's own order. */
  override suspend fun streamSources(type: String, id: String): List<StreamSourceDto> =
    request(Request.Builder().url(address.resolve("/api/stream-sources/" + encode(type) + "/" + encode(id))).get().build()).decode()
      ?: emptyList()

  /** One addon's streams; asking each addon on its own keeps the slowest from holding the rest. */
  override suspend fun streams(type: String, id: String, addon: String?): List<StreamDto> {
    val suffix = if (!addon.isNullOrEmpty()) "?addon=" + encode(addon) else ""
    return request(Request.Builder().url(address.resolve("/api/streams/" + encode(type) + "/" + encode(id) + suffix)).get().build()).decode()
      ?: emptyList()
  }

  override suspend fun addons(): List<AddonDto> =
    request(Request.Builder().url(address.resolve("/api/addons")).get().build()).decode() ?: emptyList()

  override suspend fun progressList(): List<ProgressEntryDto> =
    request(Request.Builder().url(address.resolve("/api/progress")).get().build()).decode() ?: emptyList()

  override suspend fun watchlist(): List<WatchlistEntryDto> =
    request(Request.Builder().url(address.resolve("/api/watchlist")).get().build()).decode() ?: emptyList()

  override suspend fun setWatchlist(
    type: String,
    id: String,
    name: String,
    poster: String?,
    favorite: Boolean,
  ): WatchlistToggleDto {
    val payload = json.encodeToString(
      WatchlistRequest.serializer(),
      WatchlistRequest(type, id, name, poster, favorite),
    )
    return request(Request.Builder().url(address.resolve("/api/watchlist")).post(payload.toRequestBody(mediaType)).build())
      .decode() ?: WatchlistToggleDto("$type:$id", favorite)
  }

  override suspend fun download(title: String, sourceId: String, media: MediaDto): DownloadResult {
    val payload = downloadJson.encodeToString(DownloadRequest.serializer(), DownloadRequest(title, sourceId, media))
    return request(Request.Builder().url(address.resolve("/api/downloads")).post(payload.toRequestBody(mediaType)).build())
      .decode() ?: DownloadResult()
  }

  /** One Home answer for the named rows; an empty list only asks for `order`. */
  override suspend fun home(rows: List<String>): HomeResponseDto {
    val query = "?rows=" + encode(rows.joinToString(","))
    return request(Request.Builder().url(address.resolve("/api/home$query")).get().build())
      .decode<HomeResponseDto>() ?: throw ApiError(ApiFailure.Generic)
  }

  override suspend fun downloads(): DownloadsResponseDto =
    request(Request.Builder().url(address.resolve("/api/downloads")).get().build())
      .decode<DownloadsResponseDto>() ?: throw ApiError(ApiFailure.Generic)

  override suspend fun saveProgress(
    key: String,
    position: Double,
    duration: Double,
    title: String,
    path: String?,
    poster: String?,
    addonKey: String?,
  ) {
    // The body drops what it does not have instead of sending nulls, the way the download body does.
    val payload = progressJson.encodeToString(
      ProgressRequest.serializer(),
      ProgressRequest(key, position, duration, title, path, poster, addonKey),
    )
    request(Request.Builder().url(address.resolve("/api/progress")).post(payload.toRequestBody(mediaType)).build())
  }

  private suspend fun request(request: Request): String = call(request).closing { response ->
    when {
      response.isSuccessful -> readBody(response)
      response.code == 401 -> throw ApiError(ApiFailure.SessionExpired)
      response.code == 403 -> throw ApiError(ApiFailure.Forbidden)
      response.code == 404 -> throw ApiError(ApiFailure.NotFound)
      else -> throw ApiError(ApiFailure.Generic)
    }
  }

  private inline fun <reified T> String.decode(): T? = try {
    json.decodeFromString<T>(this)
  } catch (_: Exception) {
    null
  }

  private fun encode(value: String): String = java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")

  private suspend fun call(request: Request): Response = withContext(Dispatchers.IO) {
    try {
      client.newCall(request).execute()
    } catch (error: IOException) {
      throw ApiError(ApiFailure.Unreachable)
    }
  }

  /** Like `use`, but the response is closed on the IO dispatcher: closing an unread body drains
   *  what is left of it from the socket, which must not happen on the main thread. */
  private suspend inline fun <T> Response.closing(block: (Response) -> T): T =
    try {
      block(this)
    } finally {
      withContext(NonCancellable + Dispatchers.IO) { close() }
    }

  /** The body streams from the socket, so it is read off the main thread like the call itself. */
  private suspend fun readBody(response: Response): String = withContext(Dispatchers.IO) {
    try {
      response.body?.string().orEmpty()
    } catch (error: IOException) {
      throw ApiError(ApiFailure.Unreachable)
    }
  }

  private inline fun <reified T> String.decodeOrNull(): T? = try {
    json.decodeFromString<T>(this)
  } catch (_: Exception) {
    null
  }
}

@Serializable
private data class SourceRequest(val path: String)

@Serializable
private data class FavoriteRequest(val path: String, val favorite: Boolean)

@Serializable
private data class WatchlistRequest(
  val type: String,
  val id: String,
  val name: String,
  val poster: String? = null,
  val favorite: Boolean,
)

@Serializable
private data class DownloadRequest(val title: String, val sourceId: String, val media: MediaDto)

@Serializable
private data class TimeRequest(val time: Double)

@Serializable
private data class PlaybackStartRequest(val sourceId: String, val capabilities: ClientCapabilitiesDto, val time: Double)

@Serializable
private data class ProgressRequest(
  val key: String,
  val position: Double,
  val duration: Double,
  val title: String,
  val path: String? = null,
  val poster: String? = null,
  val addonKey: String? = null,
)
