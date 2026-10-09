# Interface conventions

How dialogs and form controls are built, so a new one looks and behaves like the
rest. The rules come from the reference dialog, Settings -> Libraries -> Add
library. The styles live in `web/src/style.css`.

## Dialogs

Every dialog is the same shell:

```tsx
<div className="identify-overlay" role="dialog" aria-modal="true" aria-label={...}
     onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
  <div className="panel identify-card dialog-split your-card">
    <div className="identify-head"><h2>...</h2><button className="icon-button" aria-label={t("common.close")}><X/></button></div>
    <div className="dialog-body">...</div>
    <footer className="dialog-foot">...</footer>
  </div>
</div>
```

- **Head:** title on the left, an X on the right. Never leave the head out: on a
  phone the X is the only way out, because there is no backdrop to tap.
- **Body:** `dialog-body` is the only thing that scrolls. Do not let the card
  scroll, or the head and footer leave the screen. A card-specific class only
  sets the width (`min(640px, 100%)` and the like).
- **Footer:** `dialog-foot`. An explanation line goes first, as a non-button
  child (`<p className="identify-hint">`, or `login-error` for a failure); it
  takes the whole row. Then the buttons, on the right: the secondary first
  (**Cancel**), the primary last. Plain text on the primary, no icon.
  Do not give a footer its own layout; `dialog-foot` already does this.
- **A dialog that only shows something** (suggestions) has a single **Close**
  button. The library list dialog has no footer on purpose (see its test): the
  X is enough.
- Do not add a bottom sheet. On a phone (`max-width: 700px`) and on a phone held
  sideways (`max-height: 500px` landscape) every dialog fills the screen from the
  top; the shell does that for any `identify-card`, no per-card rule is needed.
- Full-screen things that are not dialogs (gallery, trailer, player) follow the
  same safe-area rule below.

## Safe areas

The app can be added to the home screen. It then draws under the status bar
(`viewport-fit=cover`, translucent status bar), so anything pinned to the top
edge starts at `env(safe-area-inset-top, 0px)`: the top bar, the sidebar, the
page padding, the head of a full-screen dialog. The bottom edge already uses
`safe-area-inset-bottom`. In a browser the insets are zero, so the rule costs
nothing there, and it must not be tested away on a desktop: check it on a real
device in standalone mode.

## Form controls

- **Select:** styled globally. The arrow is drawn by the stylesheet and set in
  from the edge; do not restyle `select` per screen, and do not set a `background`
  or `padding` shorthand on one (the global rule is `!important` for that reason,
  but a shorthand is still a smell).
- **Input, select, button:** the sizes, borders, hover and focus states are
  global. A screen only changes what it must (a compact filter bar), not the look.
- **Checkbox, radio:** the accent colour is set globally.
- **Primary action:** one `primary` button per footer or toolbar.

## Toolbars that fold

The catalogue and library toolbars fold away when the listing is scrolled, and on
a phone the top bar goes with them (`catalog-compact` / `library-compact`). A
deliberate pull towards the start restores them before the list reaches its top;
small changes of direction do not. A new listing that wants the same needs the
`.fold` wrapper and `compactOnScroll`; copy the catalogue rather than inventing a
second mechanism. The detail panel's hero folds the same way (`hero-compact`).

## Checking a change

Look at it in the viewport matrix in [testing.md](testing.md), in particular a
phone upright, a phone sideways and a tablet upright. Landscape on a small screen
is where this interface usually breaks.
