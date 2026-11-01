package cz.stremiooffline.tv.data

import android.content.Context
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import javax.crypto.AEADBadTagException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Bug: once the Keystore no longer matched the encrypted file (a firmware update or a data restore
 * resets it), every read threw AEADBadTagException and the app crashed at each launch. Robolectric
 * has no Android Keystore, so a plain file stands in: it records which key wrote it, and reads
 * throw the way the real store does when that key is gone.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SessionStoreRecoveryTest {

  private val context: Context = ApplicationProvider.getApplicationContext()

  private class KeyedStore(context: Context, var masterKey: String, var masterKeyUsable: Boolean = true) :
    SessionStore(context) {
    private val appContext = context.applicationContext

    override fun openPrefs(): SharedPreferences {
      if (!masterKeyUsable) throw SecurityException("master key unusable", AEADBadTagException())
      val file = appContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
      val keyset = file.getString(KEYSET, null)
      if (keyset == null) file.edit().putString(KEYSET, masterKey).commit()
      return if (keyset == null || keyset == masterKey) file else Undecryptable(file)
    }

    override fun deleteMasterKey() {
      masterKey = "regenerated"
      masterKeyUsable = true
    }
  }

  private class Undecryptable(file: SharedPreferences) : SharedPreferences by file {
    override fun getAll(): Map<String, *> = throw SecurityException("keyset", AEADBadTagException())
    override fun getString(key: String?, defValue: String?): String? =
      throw SecurityException("value", AEADBadTagException())
  }

  @Before
  fun seedFileWrittenWithOldKey() {
    KeyedStore(context, masterKey = "old").apply {
      serverUrl = "http://server:8090"
      saveSession("http://server:8090", "cookie")
    }
  }

  @Test
  fun `a file the current key cannot decrypt is replaced by an empty one`() {
    val store = KeyedStore(context, masterKey = "new")

    assertNull(store.serverUrl)
    assertNull(store.loadSession("http://server:8090"))

    store.serverUrl = "http://other:8090"
    assertEquals("http://other:8090", KeyedStore(context, masterKey = "new").serverUrl)
  }

  @Test
  fun `an unusable master key is deleted and regenerated`() {
    val store = KeyedStore(context, masterKey = "new", masterKeyUsable = false)

    assertNull(store.serverUrl)
    assertEquals("regenerated", store.masterKey)
  }

  private companion object {
    const val FILE = "stremio_offline_tv"
    const val KEYSET = "__keyset__"
  }
}
