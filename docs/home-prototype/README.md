# Home prototype

A static layout study for [the Home specification](../home-spec.md). It links the
real `web/src/style.css`, so the chrome, tokens and tiles stay current, and adds
only `home.css`. Open `home.html` straight from disk and resize the window.

- `#poster` switches the shelves to portrait tiles.
- `#quiet` hides the Downloads row, as with an empty queue.
- Tap More at phone width, or in a short landscape window, for the menu.

Sample data and the gradient artwork are illustrative. It is not application code
and is not covered by any test; where it disagrees with the specification, the
specification wins.
