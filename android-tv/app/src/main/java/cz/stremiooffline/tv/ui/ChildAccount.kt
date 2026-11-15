package cz.stremiooffline.tv.ui

import androidx.compose.runtime.staticCompositionLocalOf

/** Whether the signed-in account is a child account. Only wording reads it from here; what a
 *  child may open or ask is decided where the shell passes its flags explicitly. */
val LocalChildAccount = staticCompositionLocalOf { false }
