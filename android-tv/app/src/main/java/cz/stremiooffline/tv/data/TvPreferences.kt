package cz.stremiooffline.tv.data

import android.content.Context

/**
 * The device-local choices the TV keeps for itself: nothing here belongs to the account, so it
 * stays on this device instead of travelling through `/api/settings`.
 */
open class TvPreferences(context: Context) {
  private val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

  /** Off by default: a start declares the TV's real decoders so the server can hand the file over. */
  open var preferConversion: Boolean
    get() = prefs.getBoolean(KEY_PREFER_CONVERSION, false)
    set(value) {
      prefs.edit().putBoolean(KEY_PREFER_CONVERSION, value).apply()
    }

  companion object {
    const val FILE = "stremio_offline_tv_prefs"
    const val KEY_PREFER_CONVERSION = "prefer_conversion"
  }
}
