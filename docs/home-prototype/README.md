# Home prototype

A static layout study for [the Home specification](../home-spec.md). It links the
real `web/src/style.css`, so the chrome, tokens and tiles stay current, and adds
`home.css` plus `home.js`. The script is a separate file because a served copy
sits behind `script-src 'self'`. Open `home.html` straight from disk and resize
the window.

- `#poster` switches the shelves to portrait tiles.
- `#quiet` hides the Downloads row, as with an empty queue.
- Tap More at phone width, or in a short landscape window under 981 px wide, for the menu.
- A window wider than 980 px and shorter than 501 px keeps every destination in the sidebar.
- Between 501 px and 680 px tall, in landscape and wider than 700 px, the eyebrow and the addon block drop and the sidebar can scroll.

Sample data and the gradient artwork are illustrative. It is not application code
and is not covered by any test; where it disagrees with the specification, the
specification wins.
