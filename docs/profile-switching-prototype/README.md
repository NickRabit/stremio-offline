# Profile switching prototype

A static layout study for [the profile switching specification](../profile-switching-spec.md).
`web.html` links the real `web/src/style.css`, so the dialog shell, the fields,
the buttons and the More menu are the app's own; `web.css` adds only what the
specification proposes. `tv.html` draws a 1920x1080 television with the Android
TV tokens from `ui/theme/Theme.kt`.

Open the files straight from disk, or serve the repository root:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

- `web.html#entry`: where the switcher opens from. Narrow the window below
  700 px for the phone layout, where the entry is in the More menu.
- `#choose`, `#pin`, `#error`, `#wait`, `#locked`, `#password`: the dialog's steps.
- `#admin`: the block an administrator gets in the account dialog.
- `#own`: the signed-in account's own PIN in Settings.
- `?keys` draws a stand-in for the system keypad and shrinks the dialog to the
  space above it, the way the app does when the keyboard is up. `?shot` hides
  the state switcher.
- `tv.html#choose`, `#pin`, `#error`, `#settings`.

`screens/` holds the same views as JPEGs for the pull request: `web-*` at
1280x800, `phone-*` at 390x780 and 360x640, `phone-sideways-*` at 640x360,
`tv-*` at 1920x1080.

The labels are Czech because that is the language the design was reviewed in.
Names are illustrative. It is not application code and is not covered by any
test; where it disagrees with the specification, the specification wins.
