package cz.stremiooffline.tv.diagnostics

import cz.stremiooffline.tv.data.ClientLogLineDto
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** One recorded line, the shape the dashboard's bundle carries. */
data class LogLine(val t: String, val level: String, val message: String, val context: Map<String, String>? = null)

/**
 * The app's own log: a bounded ring buffer of the last [CAPACITY] lines and the crash file a
 * fatal exception leaves for the next run. One instance per process, so every caller -- the API
 * client, the player, the lifecycle -- records into the same place.
 */
object AppLog {
  const val CAPACITY = 1000
  private const val CRASH_NAME = "tv-crash.txt"
  private const val WARN_WINDOW_MS = 60_000L

  private val lines = ArrayDeque<LogLine>()
  private val lastWarn = HashMap<String, Long>()
  private var installed = false
  private val clock = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
    timeZone = TimeZone.getTimeZone("UTC")
  }

  fun record(level: String, message: String, context: Map<String, String>? = null, at: Long = System.currentTimeMillis()) {
    synchronized(lines) {
      lines.addLast(LogLine(stamp(at), level, message, context?.takeIf { it.isNotEmpty() }))
      while (lines.size > CAPACITY) lines.removeFirst()
    }
  }

  fun info(message: String, context: Map<String, String>? = null) = record("INFO", message, context)

  fun warn(message: String, context: Map<String, String>? = null) = record("WARN", message, context)

  fun error(message: String, context: Map<String, String>? = null) = record("ERROR", message, context)

  /** Every line the buffer holds, oldest first. */
  fun snapshot(): List<LogLine> = synchronized(lines) { lines.toList() }

  fun clear() = synchronized(lines) { lines.clear(); lastWarn.clear() }

  /** One API failure: what was asked, why it failed and how long it took. */
  fun apiFailure(method: String, path: String, status: Int?, durationMs: Long) {
    record("WARN", "API $method $path", mapOf("status" to (status?.toString() ?: "failed"), "durationMs" to durationMs.toString()))
  }

  /**
   * True when a WARN for [key] may go out now: the same failure is reported at most once per
   * [WARN_WINDOW_MS], so a looping player cannot flood the server's own log.
   */
  fun allowWarn(key: String, now: Long = System.currentTimeMillis()): Boolean = synchronized(lines) {
    val last = lastWarn[key]
    if (last != null && now - last < WARN_WINDOW_MS) false
    else {
      lastWarn[key] = now
      true
    }
  }

  /**
   * The lines a bundle carries, with the crash left by the previous run, when there is one. The
   * server refuses more than [CAPACITY] lines, and a full buffer is exactly what a crash leaves
   * behind: the oldest buffer line makes room for the crash rather than the crash being dropped.
   */
  fun bundleLines(crash: String?, at: Long = System.currentTimeMillis()): List<ClientLogLineDto> {
    val crashLines = if (crash.isNullOrBlank()) emptyList() else listOf(ClientLogLineDto(stamp(at), "ERROR", crash))
    val room = (CAPACITY - crashLines.size).coerceAtLeast(0)
    return crashLines + snapshot().takeLast(room).map { ClientLogLineDto(it.t, it.level, it.message, it.context) }
  }

  /** `SimpleDateFormat` is not thread safe, so every use is taken under the same lock. */
  private fun stamp(at: Long): String = synchronized(lines) { clock.format(Date(at)) }

  fun crashFile(dir: File): File = File(dir, CRASH_NAME)

  /** The text of the crash the previous run left, or null when there is none. */
  fun readCrash(file: File): String? =
    runCatching { file.takeIf { it.isFile }?.readText()?.takeIf { it.isNotBlank() } }.getOrNull()

  fun clearCrash(file: File) {
    runCatching { file.delete() }
  }

  fun writeCrash(file: File, thread: String, error: Throwable) {
    runCatching { file.writeText(crashText(thread, error)) }
  }

  /**
   * The handler a crash is recorded through: the line joins the buffer and the stack trace is
   * written to [file], which the next start uploads with its diagnostics.
   */
  fun crashHandler(file: File, previous: Thread.UncaughtExceptionHandler?): Thread.UncaughtExceptionHandler =
    Thread.UncaughtExceptionHandler { thread, error ->
      record("ERROR", "Uncaught exception", mapOf("type" to error.javaClass.name, "thread" to thread.name))
      writeCrash(file, thread.name, error)
      previous?.uncaughtException(thread, error)
    }

  fun installCrashHandler(file: File) {
    synchronized(lines) {
      // An activity is recreated on a locale change; the handler is installed only once.
      if (installed) return
      installed = true
    }
    Thread.setDefaultUncaughtExceptionHandler(crashHandler(file, Thread.getDefaultUncaughtExceptionHandler()))
  }

  private fun crashText(thread: String, error: Throwable): String = buildString {
    append("Uncaught exception on ").append(thread).append('\n')
    append(error.javaClass.name).append(": ").append(error.message.orEmpty()).append('\n')
    append(error.stackTrace.joinToString("\n") { "  at $it" })
  }

  /** Kept for the tests: how many lines the buffer currently holds. */
  val size: Int get() = synchronized(lines) { lines.size }
}
