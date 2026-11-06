package cz.stremiooffline.tv.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.common.BitMatrix
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

fun qrMatrix(text: String): BitMatrix = QRCodeWriter().encode(
  text,
  BarcodeFormat.QR_CODE,
  0,
  0,
  mapOf(EncodeHintType.MARGIN to 0, EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M),
)

/** Dark modules on a white card with its own quiet zone, so a phone camera reads it on a dark screen. */
@Composable
fun QrCode(text: String, modifier: Modifier = Modifier) {
  val matrix = remember(text) { qrMatrix(text) }
  Canvas(
    modifier
      .semantics { contentDescription = text }
      .background(Color.White, RoundedCornerShape(6.dp))
      .padding(8.dp),
  ) {
    val cell = minOf(size.width / matrix.width, size.height / matrix.height)
    for (y in 0 until matrix.height) {
      for (x in 0 until matrix.width) {
        if (matrix[x, y]) drawRect(Color.Black, Offset(x * cell, y * cell), Size(cell, cell))
      }
    }
  }
}
