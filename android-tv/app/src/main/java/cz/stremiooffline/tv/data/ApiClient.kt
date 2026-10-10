package cz.stremiooffline.tv.data

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/** Every way a call can fail, before it is turned into a catalogued message. */
enum class ApiFailure {
  Unreachable, Incompatible, BadCredentials, TooMany, NeedsSetup, MustChangePassword, SessionExpired, Generic
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
) {

  private val json = Json { ignoreUnknownKeys = true }
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

  suspend fun status(): ServerStatus {
    call(Request.Builder().url(address.resolve("/api/status")).get().build()).use { response ->
      val parsed = readBody(response).decodeOrNull<StatusResponse>()
      if (parsed?.status != "ok") throw ApiError(ApiFailure.Incompatible)
      return ServerStatus(parsed.version.orEmpty())
    }
  }

  suspend fun login(username: String, password: String): LoginResult {
    val payload = json.encodeToString(LoginRequest.serializer(), LoginRequest(username, password, true))
    call(Request.Builder().url(address.resolve("/api/auth/login")).post(payload.toRequestBody(mediaType)).build())
      .use { response ->
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
    call(Request.Builder().url(address.resolve("/api/auth/me")).get().build()).use { response ->
      val body = readBody(response)
      if (response.code == 401) throw ApiError(ApiFailure.SessionExpired)
      val parsed = body.decodeOrNull<MeResponse>() ?: throw ApiError(ApiFailure.Incompatible)
      if (parsed.setup) return MeResult.Setup
      return MeResult.SignedIn(parsed.username ?: throw ApiError(ApiFailure.SessionExpired), parsed.language)
    }
  }

  suspend fun settings(): SettingsResponse {
    call(Request.Builder().url(address.resolve("/api/settings")).get().build()).use { response ->
      if (!response.isSuccessful) throw ApiError(ApiFailure.Generic)
      return readBody(response).decodeOrNull<SettingsResponse>() ?: SettingsResponse()
    }
  }

  suspend fun logout() {
    try {
      call(Request.Builder().url(address.resolve("/api/auth/logout")).post("{}".toRequestBody(mediaType)).build()).use { }
    } catch (_: ApiError) {
    }
  }

  private suspend fun call(request: Request): Response = withContext(Dispatchers.IO) {
    try {
      client.newCall(request).execute()
    } catch (error: IOException) {
      throw ApiError(ApiFailure.Unreachable)
    }
  }

  private fun readBody(response: Response): String =
    try {
      response.body?.string().orEmpty()
    } catch (error: IOException) {
      throw ApiError(ApiFailure.Unreachable)
    }

  private inline fun <reified T> String.decodeOrNull(): T? = try {
    json.decodeFromString<T>(this)
  } catch (_: Exception) {
    null
  }
}
