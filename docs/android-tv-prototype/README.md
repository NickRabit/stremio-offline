# Android TV prototype

A static layout study for [the Android TV specification](../android-tv-spec.md).
Open `index.html` straight from disk. It draws a 1920x1080 television scaled to
the window and answers to the arrow keys, Enter and Esc as a remote would; the
pad under the screen does the same with a mouse. The buttons above the screen
jump to sign-in, Home, Catalog, Library, a movie, a series, the player,
Settings and the offline state. **Safe area** shows the 5 % overscan margin.

The colours and type are the web app's own tokens from `web/src/style.css`,
copied rather than linked so the file stays self-contained. Sample titles are
open films and the artwork is generated. It is not application code and is not
covered by any test; where it disagrees with the specification, the
specification wins.
