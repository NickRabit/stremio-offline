package cz.stremiooffline.tv.probe

import java.io.File
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineExceptionHandler

class LeakProbe : AbstractCoroutineContextElement(CoroutineExceptionHandler), CoroutineExceptionHandler {
  override fun handleException(context: CoroutineContext, exception: Throwable) {
    val text = "=== LEAKPROBE ${System.currentTimeMillis()} thread=${Thread.currentThread().name} ctx=$context\n${exception.stackTraceToString()}\n"
    System.err.print(text)
    System.getenv("LEAK_PROBE_LOG")?.let { File(it).appendText(text) }
  }
}
