package cz.stremiooffline.tv.ui

import android.icu.text.MeasureFormat
import android.icu.util.Measure
import android.icu.util.MeasureUnit
import java.util.Locale

private val HOURS_MINUTES = Regex("""^(\d+)\s*h(?:ours?|rs?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?$""", RegexOption.IGNORE_CASE)
private val MINUTES_ONLY = Regex("""^(\d+)\s*m(?:in(?:utes?)?)?$""", RegexOption.IGNORE_CASE)
private val ISO_DURATION = Regex("""^PT(?:(\d+)H)?(?:(\d+)M)?$""", RegexOption.IGNORE_CASE)
private val PLAIN_NUMBER = Regex("""^\d+$""")

/** Minutes from a meta's `runtime`, read as the server and the web read it: "136 min",
 *  "2h 16min", "2 h 16 min", "PT2H16M" or a bare number. */
fun runtimeMinutes(raw: String?): Int? {
  val text = raw?.trim().orEmpty()
  val minutes = ISO_DURATION.matchEntire(text)?.takeIf { it.groupValues[1].isNotEmpty() || it.groupValues[2].isNotEmpty() }
    ?.let { (it.groupValues[1].toIntOrNull() ?: 0) * 60 + (it.groupValues[2].toIntOrNull() ?: 0) }
    ?: HOURS_MINUTES.matchEntire(text)?.let { it.groupValues[1].toInt() * 60 + (it.groupValues[2].toIntOrNull() ?: 0) }
    ?: MINUTES_ONLY.matchEntire(text)?.groupValues?.get(1)?.toIntOrNull()
    ?: text.takeIf { PLAIN_NUMBER.matches(it) }?.toIntOrNull()
  return minutes?.takeIf { it > 0 }
}

/** The detail's run time in the viewer's units, "2 h 16 min"; a short text it cannot read is
 *  kept as the addon wrote it. */
fun runtimeLabel(raw: String?, locale: Locale): String? {
  val minutes = runtimeMinutes(raw)
  if (minutes == null) return raw?.trim()?.takeIf { it.isNotEmpty() && it.length <= 24 }
  val format = MeasureFormat.getInstance(locale, MeasureFormat.FormatWidth.SHORT)
  val hours = minutes / 60
  val rest = minutes % 60
  return listOfNotNull(
    hours.takeIf { it > 0 }?.let { format.format(Measure(it, MeasureUnit.HOUR)) },
    rest.takeIf { it > 0 }?.let { format.format(Measure(it, MeasureUnit.MINUTE)) },
  ).joinToString(" ")
}
