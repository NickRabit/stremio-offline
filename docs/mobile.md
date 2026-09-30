# Phones and tablets

Stremio Offline runs in your mobile browser. For convenient access, add it to
your Home Screen and launch it like an app.

Before you begin, open your instance using the address of your NAS or Docker
host, for example `http://192.168.1.100:8090`. Your phone or tablet must be able
to reach that server. `localhost` on your phone refers to the phone itself.

## iPhone and iPad

Adding Stremio Offline to the Home Screen is the recommended way to use it on
iOS and iPadOS. It opens in its own window without Safari's address bar, leaving
more room for browsing and playback.

1. Open your Stremio Offline address in **Safari**.
2. Open the **Share** menu.
3. Select **Add to Home Screen**.
4. If **Open as Web App** is available, leave it enabled.
5. Tap **Add**.
6. Launch **Stremio Offline** from the new Home Screen icon and sign in if prompted.

If **Add to Home Screen** is missing, use **Edit Actions** in the Share menu to
add it.

See Apple's instructions for [iPhone](https://support.apple.com/guide/iphone/iphea86e5236/ios)
and [iPad](https://support.apple.com/guide/ipad/ipad8f1f7a29/ipados).

## Android phones and tablets

Chrome can install web apps or add a website shortcut to the Home Screen.

1. Open your Stremio Offline address in **Chrome**.
2. Open the **three-dot menu**.
3. Look for **Install and create shortcut**, **Install app**, or **Add to Home screen**.
4. Choose **Install** if offered, then follow the on-screen instructions.
5. Launch **Stremio Offline** from its new icon.

The menu wording and whether Chrome offers an app installation or a shortcut
depend on your browser version and how your instance is served. A shortcut may
open in a regular browser tab.

See [Google's instructions for Android](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=en).

## Server access and downloads

Adding the app to your Home Screen does not copy your library to the device.
Downloads saved to the library remain on your NAS or Docker host, and playback
still requires a connection to it.

At home, use the server's local network address. For access away from home,
follow the [security guidance](../README.md#security) and use a VPN or an HTTPS
reverse proxy.
