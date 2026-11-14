// Static study: names and states are illustrative. Add ?shot to hide the state switcher and
// ?keys to draw a stand-in for the system keypad.
const icon = (path) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
const I = {
  lock: icon('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  key: icon('<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3"/>'),
  check: icon('<path d="M20 6 9 17l-5-5"/>'),
  x: icon('<path d="M18 6 6 18M6 6l12 12"/>'),
  back: icon('<path d="M19 12H5M12 19l-7-7 7-7"/>'),
  down: icon('<path d="m6 9 6 6 6-6"/>'),
  users: icon('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>'),
  out: icon('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  dot: icon('<circle cx="12" cy="12" r="3"/>'),
};
const PROFILES = [["Ondra", "", "password", true], ["Jana", "b", "pin"], ["Děti", "c", "none"], ["Babička", "d", "pin"]];
const need = { pin: `${I.lock} PIN`, password: `${I.key} Heslo`, none: "" };
const face = (name, tone) => `<span class="profile-face ${tone}">${name[0]}</span>`;

const chrome = (menu) => `
  <header class="topbar"><div class="brand"><div class="brand-mark"></div><div><small>SELF-HOSTED</small><h1>Stremio <span>Offline</span></h1></div></div>
    <div class="topbar-user"><span class="online"><i></i> Server běží</span>
      <button class="profile-trigger proto-new proto-desktop-only" aria-haspopup="dialog" title="Přepnout profil">${face("Ondra", "")}<strong>Ondra</strong>${I.down}</button>
      <button class="signout" aria-label="Odhlásit">${I.out} <span class="signout-label">Odhlásit</span></button></div></header>
  <div class="proto-page"><h2>Domů</h2><p>Na širokém rozložení otevírá přepínač jméno účtu v horní liště. Na telefonu je položka
    <b>Přepnout profil</b> v nabídce Více, hned nad odhlášením. Obojí se ukáže jen tehdy, když je na co přepnout.</p></div>
  <nav class="proto-tabbar"><span class="on">${I.dot}Domů</span><span>${I.dot}Katalog</span><span>${I.dot}Knihovna</span><span>${I.dot}Fronta</span><span>${I.dot}Více</span></nav>
  ${menu ? `<div class="more-menu open proto-open" role="menu"><button role="menuitem">${I.dot}<span>Oblíbené</span></button><button role="menuitem">${I.dot}<span>Sledované</span></button><button role="menuitem">${I.dot}<span>Nastavení</span></button><hr>
    <button role="menuitem" class="proto-new">${I.users}<span>Přepnout profil</span></button><button role="menuitem">${I.out}<span>Odhlásit</span></button></div>` : ""}`;

const dialog = (head, body, foot, card = "profile-card") => `<div class="identify-overlay" role="dialog" aria-modal="true">
  <div class="panel identify-card dialog-split ${card}"><div class="identify-head">${head}<button class="icon-button" aria-label="Zavřít">${I.x}</button></div>
  <div class="dialog-body">${body}</div>${foot ? `<footer class="dialog-foot">${foot}</footer>` : ""}</div></div>`;

const choose = () => dialog("<h2>Přepnout profil</h2>", `<div class="profile-list">${PROFILES.map(([name, tone, unlock, current]) =>
  `<button class="profile-row${current ? " current" : ""}"${current ? " disabled" : ""}>${face(name, tone)}<strong>${name}</strong><small>${current ? `${I.check} Právě přihlášen` : need[unlock]}</small></button>`).join("")}</div>`,
  `<button>Zavřít</button>`);

const unlockHead = (name) => `<div class="profile-head-back"><button class="icon-button" aria-label="Zpět">${I.back}</button><h2>${name}</h2></div>`;
const pin = (value, error, wait) => dialog(unlockHead("Jana"), `<div class="profile-unlock">${face("Jana", "b")}<p class="hint">Zadejte PIN profilu.</p>
  <input class="profile-pin" type="password" inputmode="numeric" pattern="[0-9]*" autocomplete="off" maxlength="8" aria-label="PIN" value="${value}" autofocus>
  <button class="profile-link">Použít heslo</button></div>`,
  `${error ? `<p class="login-error">${error}</p>` : ""}<button>Zrušit</button><button class="primary"${wait ? " disabled" : ""}>${wait ? "Přepnout (28 s)" : "Přepnout"}</button>`);
const password = (locked) => dialog(unlockHead("Jana"), `<div class="profile-unlock">${face("Jana", "b")}
  <p class="hint">${locked ? "PIN je po mnoha chybných pokusech zamčený. Odemkne ho přihlášení heslem." : "Zadejte heslo profilu."}</p>
  <input class="profile-password" type="password" autocomplete="current-password" aria-label="Heslo" value="heslo123" autofocus></div>`,
  `<button>Zrušit</button><button class="primary">Přepnout</button>`);

const admin = () => dialog("<h2>Upravit účet</h2>", `<section class="user-edit-section">
  <div class="user-edit-fields"><label class="user-edit-field"><span>Uživatelské jméno</span><input value="Jana"></label>
    <label class="user-edit-field"><span>Role</span><select><option>Uživatel</option></select></label></div>
  <div class="user-edit-password"><label class="user-edit-field"><span>Nastavit heslo</span><input type="password" placeholder="Nové heslo"></label><button>Nastavit</button></div>
  <div class="profile-block proto-new" style="padding:12px"><h3>Přepínání profilů</h3>
    <label class="user-switch"><span class="switch"><input type="checkbox" checked><span></span></span><span>Zobrazit v přepínání profilů</span></label>
    <div class="profile-block-row admin"><label class="user-edit-field"><span>K otevření profilu je potřeba</span><select><option>PIN</option><option>Nic</option><option>Heslo</option></select></label>
      <div class="user-edit-field"><span style="font-size:12px;color:var(--muted)">PIN</span><div class="profile-pin-state"><span>${I.check} PIN je nastaven</span><button>Změnit</button><button>Odebrat</button></div></div></div>
    <p class="identify-hint">PIN chrání před překliknutím, ne před někým, kdo ho odkoukal. Správcovský účet nejde otevřít bez PINu nebo hesla. Heslo funguje vždy.</p></div>
  </section>`, `<button>Zrušit</button><button class="primary">Uložit</button>`, "user-edit-card");

const own = () => `${chrome(false).replace(/<div class="proto-page">[\s\S]*?<\/div>/, `<div class="proto-page"><h2>Nastavení</h2><div class="proto-settings">
  <div class="panel proto-new"><h3>PIN profilu</h3><p class="identify-hint">Správce zařadil tento účet do přepínání profilů. PIN slouží jen k přepnutí na už přihlášeném zařízení; k přihlášení je dál potřeba heslo.</p>
    <div class="profile-block-row"><label class="user-edit-field"><span>Současné heslo</span><input type="password" value="heslo123"></label>
      <label class="user-edit-field"><span>Nový PIN (4 až 8 číslic)</span><input type="password" inputmode="numeric" value="4821"></label></div>
    <div class="actions" style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap"><button>Odebrat PIN</button><button class="primary">Uložit PIN</button></div></div></div></div>`)}`;

const keys = (wide) => `<div class="proto-keys${wide ? " wide" : ""}">${(wide ? ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"] : ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"])
  .map((key) => `<span${/\d/.test(key) ? "" : ' class="fn"'}>${key}</span>`).join("")}</div>`;

const STATES = {
  entry: ["Vstup", () => chrome(innerWidth <= 700)],
  choose: ["Výběr", choose],
  pin: ["PIN", () => pin("123")],
  error: ["Špatný PIN", () => pin("", "Špatný PIN.")],
  wait: ["Čekání", () => pin("", "Příliš mnoho chybných pokusů. Zkuste to znovu za 28 s.", true)],
  locked: ["Zamčený PIN", () => password(true)],
  password: ["Heslo", () => password(false)],
  admin: ["Správa účtu", admin],
  own: ["Vlastní PIN", own],
};

const params = new URLSearchParams(location.search);
if (params.has("shot")) document.body.classList.add("shot");
const render = () => {
  const id = location.hash.slice(1) in STATES ? location.hash.slice(1) : "choose";
  const withKeys = params.has("keys");
  const wide = innerHeight < 500;
  const keysHeight = wide ? 100 : 232;
  document.documentElement.style.setProperty("--dialog-viewport-height", withKeys ? `calc(100dvh - ${keysHeight}px)` : "100dvh");
  document.getElementById("root").innerHTML = STATES[id][1]() + (withKeys ? keys(wide) : "");
  document.getElementById("switch").innerHTML = Object.entries(STATES).map(([key, [label]]) => `<a href="#${key}"${key === id ? ' class="on"' : ""}>${label}</a>`).join("");
};
addEventListener("hashchange", render);
addEventListener("resize", render);
render();
