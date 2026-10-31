// Static study: sample data and gradient artwork are illustrative.
const ART = ["#3c2a4d,#1d3a4e", "#4a2f22,#7a4b2b", "#1e3b33,#2e5d4c", "#2a2f55,#51346e", "#55302f,#2a1c26", "#203246,#4f6d7a", "#3f3a20,#6e5a2c", "#2d2236,#6b2f4a"];
const PEOPLE = [
  ["Bryan Cranston", "Walter White", 1], ["Aaron Paul", "Jesse Pinkman", 1], ["Anna Gunn", "Skyler White", 1],
  ["Dean Norris", "Hank Schrader", 1], ["Betsy Brandt", "Marie Schrader", 0], ["RJ Mitte", "Walter White Jr.", 1],
  ["Bob Odenkirk", "Saul Goodman", 1], ["Giancarlo Esposito", "Gustavo Fring", 1], ["Jonathan Banks", "Mike Ehrmantraut", 0],
];
const MOVIE_PEOPLE = [["Tim Robbins", "Andy Dufresne", 1], ["Morgan Freeman", "Ellis Redding", 1], ["Bob Gunton", "Warden Norton", 1], ["William Sadler", "Heywood", 0], ["Clancy Brown", "Captain Hadley", 1], ["Gil Bellows", "Tommy", 1], ["James Whitmore", "Brooks Hatlen", 0]];
const MOVIE_RELATED = [["Zelená míle", "1999", 1], ["Forrest Gump", "1994", 0], ["Kmotr", "1972", 1], ["Sedm", "1995", 0], ["Klub rváčů", "1999", 0], ["Nedotknutelní", "2011", 0], ["Pianista", "2002", 0], ["Pulp Fiction", "1994", 0]];
const RELATED = [["Better Call Saul", "2015", 1], ["Ozark", "2017", 0], ["Narcos", "2015", 0], ["The Wire", "2002", 1], ["Dexter", "2006", 0], ["Sons of Anarchy", "2008", 0], ["Peaky Blinders", "2013", 0], ["True Detective", "2014", 0]];
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  play: svg('<path d="M9 9.003a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997A1 1 0 0 1 9 14.996z"/><circle cx="12" cy="12" r="10"/>'),
  trailer: svg('<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>'),
  down: svg('<path d="m6 9 6 6 6-6"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  restart: svg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>'),
  drive: svg('<path d="M10 16h.01"/><path d="M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M21.946 12.013H2.054"/><path d="M6 16h.01"/>'),
  dl: svg('<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>'),
  x: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
};
// The saved position and the row that will play, exactly as LibraryTitleDetail draws them today.
const source = (series) => `${series ? `<div class="library-detail-progress"><div class="progress" role="progressbar" aria-valuenow="38"><i style="width:38%"></i></div><small>Zbývá 31 min · S01E04</small><button type="button" class="icon-button" title="Zapomenout">${ICON.x}</button></div>` : ""}
    <div class="library-detail-source proto-source"><span class="proto-source-label">Přehraje se</span><i>HTTP</i><strong>FullHD</strong><small>Cineshare - Tišnov</small><b>${series ? "1.4 GB" : "2.0 GB"}</b><small><em class="lang-badge">EN</em><em class="lang-badge">CZ</em></small>
    <span class="proto-file">${series ? "Breaking.Bad.S01E04.1080p.BluRay.x264.CZ.EN.mkv" : "The.Shawshank.Redemption.1994.1080p.BluRay.x265.mkv"}</span></div>`;
const initials = (name) => name.split(" ").map((part) => part[0]).slice(0, 2).join("");

const views = {
  series: { label: "Seriál (TMDB)", build: () => detail({ series: true, tmdb: true }) },
  movie: { label: "Film (TMDB)", build: () => detail({ series: false, tmdb: true }) },
  loading: { label: "Načítání", build: () => detail({ series: true, tmdb: true, loading: true }) },
  nokey: { label: "Bez klíče TMDB", build: () => detail({ series: true, tmdb: false }) },
};

function hero({ series }) {
  return `<div class="hero library-detail-hero has-chips"><div class="detail-chips"><div class="library-detail-chips"><div class="title-chips">
    <span class="pill">${series ? "Seriál" : "Film"}</span><a class="trailer-action" href="#">${ICON.trailer}TRAILER</a>
    <div class="title-links"><a href="#">ČSFD</a><a href="#">TMDB</a><a href="#">IMDb</a></div></div></div></div>
    <div class="detail-copy"><h2>${series ? "Perníkový táta" : "Vykoupení z věznice Shawshank"}</h2>
    <p class="meta-line"><i class="imdb-rating">★ ${series ? "9.5" : "9.3"}</i> · ${series ? "2008–2013 · 5 sérií" : "1994 · 2 h 22 min"} · <em class="age-badge">${series ? "15+" : "12+"}</em> · Krimi · Drama</p>
    <p class="original-line">Původní název <b>${series ? "Breaking Bad" : "The Shawshank Redemption"}</b> · angličtina</p>
    ${series ? `<span class="next-episode">Další díl <b>S06E03 „Nový začátek“</b> · čt 7. 11.</span>` : ""}
    <p class="library-detail-synopsis">${series ? "" : "Bankéř Andy Dufresne je odsouzen za vraždu manželky a jejího milence. Ve věznici Shawshank si získá přátelství Reda a postupně i respekt dozorců."}${series ? `Středoškolský učitel chemie se po zjištění, že má rakovinu plic, spojí s bývalým studentem a začne vařit pervitin, aby zajistil rodinu.` : ""}</p></div></div>
    ${source(series)}
    <div class="library-detail-actions">
      <div class="actions library-detail-play"><div class="split-button"><button type="button" class="primary">${ICON.play} ${series ? "Pokračovat S01E04" : "Přehrát"}</button><button type="button" class="split-button-toggle primary" title="Vybrat zdroj">${ICON.down}</button></div></div>
      <button type="button" class="icon-button library-detail-icon-action" title="Přehrát od začátku">${ICON.restart}</button>
      <button type="button" class="icon-button library-detail-icon-action" aria-pressed="false" title="Označit jako zhlédnuté">${ICON.check}</button>
      <div class="split-button library-detail-save"><button type="button">${ICON.drive} <span class="library-detail-action-label">Do knihovny</span></button><button type="button" class="split-button-toggle" title="Uložit jinam…">${ICON.down}</button></div>
      <button type="button">${ICON.dl} <span class="library-detail-action-label">Uložit do tohoto zařízení</span></button>
    </div>`;
}

function crewLine(series) {
  return series
    ? `<p class="extras-crew">Tvůrce <button>Vince Gilligan</button> · Scénář <button>Peter Gould</button>, <button>George Mastras</button></p>`
    : `<p class="extras-crew">Režie <button>Frank Darabont</button> · Scénář <button>Frank Darabont</button> · Předloha <button>Stephen King</button></p>`;
}

function people({ tmdb, loading, series }) {
  if (loading) return `<section class="extras-row extras-skeleton" aria-busy="true"><h3>Herci a tvůrci</h3><div class="extras-strip">${Array.from({ length: 7 }, () => `<div class="person"><span class="person-face"></span><strong></strong></div>`).join("")}</div></section>`;
  const all = series ? PEOPLE : MOVIE_PEOPLE;
  const list = tmdb ? all : all.slice(0, 3).map(([name]) => [name, "", 0]);
  return `<section class="extras-row"><h3>Herci a tvůrci ${tmdb ? "<small>Vyberte jméno pro hledání v katalozích</small>" : ""}</h3>
    ${tmdb ? crewLine(series) : `<p class="extras-crew">${series ? "Scénář <button>Vince Gilligan</button>" : "Režie <button>Frank Darabont</button>"}</p>`}
    <div class="extras-strip">${list.map(([name, role, photo]) => `<button class="person" title="Hledat „${name}“">
      <span class="person-face${photo ? " photo" : ""}">${photo ? "" : initials(name)}</span><strong>${name}</strong>${role ? `<small>${role}</small>` : ""}</button>`).join("")}</div></section>`;
}

function related({ tmdb, loading, series }) {
  if (!tmdb) return "";
  if (loading) return `<section class="extras-row extras-skeleton" aria-busy="true"><h3>Podobné tituly</h3><div class="extras-strip">${Array.from({ length: 7 }, () => `<div class="related"><span class="related-art"></span><strong></strong></div>`).join("")}</div></section>`;
  return `<section class="extras-row"><h3>Podobné tituly</h3><div class="extras-strip">${(series ? RELATED : MOVIE_RELATED).map(([name, year, owned], index) => `<button class="related">
    <span class="related-art" style="background:linear-gradient(160deg,${ART[index % ART.length]})">${name}</span><strong>${name}</strong><small>${year}${owned ? ` · <span class="in-library">V knihovně</span>` : ""}</small></button>`).join("")}</div></section>`;
}

function detail(options) {
  return `<p class="proto-caption"><b>Celý detail titulu</b> (otevřený z katalogu, místní knihovny i Jellyfin/Emby; boční panel katalogu se nemění): hero zůstává, pod tlačítky přibydou dva řádky. ${options.tmdb ? "" : "Bez klíče TMDB zůstanou jen jména z doplňku a řádek podobných titulů se nezobrazí."}</p>
  <div class="proto-frame"><div class="browse-head">‹ ${options.series ? "Perníkový táta" : "Vykoupení z věznice Shawshank"}</div><div class="browse-scroll">
  <div class="library-title-detail proto-art">${hero(options)}
  <div class="title-extras">${people(options)}${related(options)}</div></div></div></div>`;
}

function render() {
  const key = views[location.hash.slice(1)] ? location.hash.slice(1) : "series";
  document.getElementById("root").innerHTML = views[key].build();
  if (location.search.includes("shot")) document.getElementById("switch").style.display = "none";
  document.getElementById("switch").innerHTML = Object.entries(views).map(([id, view]) => `<a href="#${id}" class="${id === key ? "on" : ""}">${view.label}</a>`).join("");
}
addEventListener("hashchange", render);
render();
