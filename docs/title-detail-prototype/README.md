# Title detail prototype

A static layout study for [the richer title detail specification](../title-detail-spec.md).
`detail.html` links the real `web/src/style.css`, so the detail surface, the
chips, the split buttons and the source row are the app's own; `detail.css`
adds only what the specification proposes. `tv.html` draws a 1920x1080
television with the Android TV tokens from `ui/theme/Theme.kt`.

Serve the repository root over HTTP (the pages load their scripts as separate
files) and open `detail.html` or `tv.html`:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

- `detail.html#series`, `#movie`: the full detail with the new rows.
- `#loading`: the rows while `/extras` is on its way.
- `#nokey`: an instance without a TMDB key — addon names, no photos, no related row.
- Narrow the window below 700 px for the phone layout.
- `tv.html#top`, `#cast`, `#related`, `#series`: the TV detail as it opens, with the
  focus in the cast row, in the related row, and a series with the rows under its episodes.

`screens/` holds the same views as JPEGs for the pull request.

Sample titles, names and the gradient artwork are illustrative. It is not
application code and is not covered by any test; where it disagrees with the
specification, the specification wins.
