package cz.stremiooffline.tv.ui

import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat

/** The ten interface languages the web ships, in the `LOCALE_NAMES` order. */
val UI_LOCALE_TAGS = listOf("en", "cs", "sk", "de", "es", "fr", "it", "pl", "pt-BR", "ru")

/**
 * Applies an interface language as the app's own locale. The platform `LocaleManager` only exists
 * from API 33 and the app runs from 24, so AppCompat carries the per-app locale on every API level
 * -- `AppCompatDelegate.setApplicationLocales` stores it below 33 and hands it to the system from
 * 33 up, and recreates the activity so the string resources change.
 */
fun applyAppLocale(code: String?) {
  if (code.isNullOrBlank() || code !in UI_LOCALE_TAGS) return
  if (AppCompatDelegate.getApplicationLocales().toLanguageTags() == code) return
  AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(code))
}
