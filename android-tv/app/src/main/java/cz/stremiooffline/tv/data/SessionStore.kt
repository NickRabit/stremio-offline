package cz.stremiooffline.tv.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.security.KeyStore

/**
 * The one place the server address and the session cookie live, encrypted with the Keystore. Open
 * so a test can substitute an in-memory store.
 */
open class SessionStore(context: Context) : SessionPersistence {

  private val appContext = context.applicationContext

  // Opened on first use, not in the constructor: a test substitutes an in-memory store by
  // overriding these members, and the Android Keystore it would otherwise read is absent there.
  private val prefs: SharedPreferences by lazy { openOrReset() }

  /**
   * A Keystore that no longer matches the file (reset by a firmware update or a data restore) makes
   * every read throw. Starting empty sends the user to sign-in instead of crashing each launch.
   */
  private fun openOrReset(): SharedPreferences {
    try {
      return openPrefs().also { it.all }
    } catch (e: Exception) {
      Log.w(TAG, "Stored session cannot be decrypted, starting signed out", e)
    }
    appContext.deleteSharedPreferences(FILE)
    try {
      return openPrefs().also { it.all }
    } catch (e: Exception) {
      // The master key itself is unusable, so a new keyset cannot be written with it either.
      appContext.deleteSharedPreferences(FILE)
      deleteMasterKey()
      return openPrefs()
    }
  }

  protected open fun openPrefs(): SharedPreferences =
    EncryptedSharedPreferences.create(
      appContext,
      FILE,
      MasterKey.Builder(appContext).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
      EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
      EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

  protected open fun deleteMasterKey() {
    KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(MasterKey.DEFAULT_MASTER_KEY_ALIAS)
  }

  open var serverUrl: String?
    get() = prefs.getString(KEY_SERVER, null)
    set(value) = prefs.edit().apply { if (value == null) remove(KEY_SERVER) else putString(KEY_SERVER, value) }.apply()

  /** Signs out locally but keeps the server address, so the sign-in screen can prefill it. */
  open fun clearSession() {
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
    const val TAG = "SessionStore"
    const val FILE = "stremio_offline_tv"
    const val KEY_SERVER = "server_url"
    const val KEY_SESSION = "session"
    const val KEY_ORIGIN = "session_origin"
  }
}
