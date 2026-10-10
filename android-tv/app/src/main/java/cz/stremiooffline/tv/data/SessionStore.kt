package cz.stremiooffline.tv.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** The one place the server address and the session cookie live, encrypted with the Keystore. */
class SessionStore(context: Context) : SessionPersistence {

  private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
    context.applicationContext,
    FILE,
    MasterKey.Builder(context.applicationContext).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
  )

  var serverUrl: String?
    get() = prefs.getString(KEY_SERVER, null)
    set(value) = prefs.edit().apply { if (value == null) remove(KEY_SERVER) else putString(KEY_SERVER, value) }.apply()

  /** Signs out locally but keeps the server address, so the sign-in screen can prefill it. */
  fun clearSession() {
    prefs.edit().remove(KEY_SESSION).remove(KEY_ORIGIN).apply()
  }

  override fun loadSession(origin: String): String? =
    if (prefs.getString(KEY_ORIGIN, null) == origin) prefs.getString(KEY_SESSION, null) else null

  override fun saveSession(origin: String, value: String?) {
    prefs.edit().apply {
      if (value == null) {
        remove(KEY_SESSION)
        remove(KEY_ORIGIN)
      } else {
        putString(KEY_SESSION, value)
        putString(KEY_ORIGIN, origin)
      }
    }.apply()
  }

  private companion object {
    const val FILE = "stremio_offline_tv"
    const val KEY_SERVER = "server_url"
    const val KEY_SESSION = "session"
    const val KEY_ORIGIN = "session_origin"
  }
}
