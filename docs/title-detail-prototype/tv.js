// Static study: sample data and gradient artwork are illustrative.
const ART = ["#3c2a4d,#1d3a4e", "#4a2f22,#7a4b2b", "#1e3b33,#2e5d4c", "#2a2f55,#51346e", "#55302f,#2a1c26", "#203246,#4f6d7a", "#3f3a20,#6e5a2c"];
const PEOPLE = [["Tim Robbins", "Andy Dufresne", 1], ["Morgan Freeman", "Ellis Redding", 1], ["Bob Gunton", "Warden Norton", 1], ["William Sadler", "Heywood", 0], ["Clancy Brown", "Captain Hadley", 1], ["Gil Bellows", "Tommy", 1], ["James Whitmore", "Brooks Hatlen", 0], ["Frank Darabont", "Režie", 1]];
const SERIES_PEOPLE = [["Bryan Cranston", "Walter White", 1], ["Aaron Paul", "Jesse Pinkman", 1], ["Anna Gunn", "Skyler White", 1], ["Dean Norris", "Hank Schrader", 1], ["Betsy Brandt", "Marie Schrader", 0], ["RJ Mitte", "Walter White Jr.", 1], ["Bob Odenkirk", "Saul Goodman", 1], ["Vince Gilligan", "Tvůrce", 0]];
const RELATED = [["Zelená míle", "1999", 1], ["Forrest Gump", "1994", 0], ["Kmotr", "1972", 1], ["Sedm", "1995", 0], ["Klub rváčů", "1999", 0], ["Nedotknutelní", "2011", 0], ["Pianista", "2002", 0]];
const initials = (name) => name.split(" ").map((part) => part[0]).slice(0, 2).join("");

const heroTop = (focus) => `<div class="eyebrow">CINEMETA · FILM</div><h1>Vykoupení z věznice Shawshank</h1>
  <div class="meta"><span class="star">★ 9.3</span> · 1994 · 2 h 22 min · <span class="age">12+</span> · Drama · Krimi</div>
  <div class="meta">Původní název <b style="color:#f1f4f8">The Shawshank Redemption</b> · angličtina</div>
  <div class="desc">Bankéř Andy Dufresne je odsouzen za vraždu manželky a jejího milence. Ve věznici Shawshank si získá přátelství Reda a postupně i respekt dozorců.</div>
  <div class="actions"><div class="btn primary ${focus === "play" ? "focus" : ""}">▶ Přehrát</div><div class="btn icon">↺</div><div class="btn">Zdroje (32)</div><div class="btn">⬇ Do knihovny</div><div class="btn icon">☆</div><div class="btn icon">👁</div></div>
  <div class="source"><span class="label">PŘEHRAJE SE</span><i>HTTP</i><b>FullHD</b><span>Cineshare - Tišnov</span><b>2.0 GB</b><em>EN</em><em>CZ</em></div>`;
const people = (focusIndex, list = PEOPLE) => `<div class="row"><h2>Herci a tvůrci</h2><p class="hint">OK vyhledá jméno v katalozích</p><div class="strip">${list.map(([name, role, photo], index) => `<div class="person ${index === focusIndex ? "focus" : ""}"><div class="face ${photo ? "photo" : ""}">${photo ? "" : initials(name)}</div><strong>${name}</strong><small>${role}</small></div>`).join("")}</div></div>`;
const related = (focusIndex) => `<div class="row"><h2>Podobné tituly</h2><div class="strip">${RELATED.map(([name, year, owned], index) => `<div class="poster ${index === focusIndex ? "focus" : ""}"><div class="art" style="background:linear-gradient(160deg,${ART[index % ART.length]})">${name}</div><strong>${name}</strong><small>${year}${owned ? ` · <span class="lib">V knihovně</span>` : ""}</small></div>`).join("")}</div></div>`;

const views = {
  top: { label: "Film: úvod", html: () => `<div class="content">${heroTop("play")}${people(-1)}</div>` },
  cast: { label: "Film: herci", html: () => `<div class="content" style="transform:translateY(-250px)">${heroTop()}${people(1)}${related(-1)}</div>` },
  related: { label: "Film: podobné", html: () => `<div class="content" style="transform:translateY(-470px)">${heroTop()}${people(-1)}${related(2)}</div>` },
  series: { label: "Seriál: pod epizodami", html: () => `<div class="content" style="transform:translateY(-420px)"><div class="eyebrow">CINEMETA · SERIÁL</div><h1>Perníkový táta</h1>
    <div class="meta"><span class="star">★ 9.5</span> · 2008–2013 · <span class="age">15+</span> · Krimi · Drama</div><div class="next">Další díl <b>S06E03 „Nový začátek“</b> · čt 7. 11.</div>
    <div class="desc">Středoškolský učitel chemie se po zjištění, že má rakovinu plic, spojí s bývalým studentem a začne vařit pervitin.</div>
    <div class="actions"><div class="btn primary">▶ Pokračovat S01E04</div><div class="btn icon">↺</div><div class="btn">Zdroje (18)</div><div class="btn">⬇ Do knihovny</div><div class="btn">Stáhnout sérii</div><div class="btn icon">☆</div></div>
    <div class="source"><span class="label">PŘEHRAJE SE</span><i>HTTP</i><b>FullHD</b><span>Cineshare - Tišnov</span><b>1.4 GB</b><em>EN</em><em>CZ</em></div>
    <div class="seasons"><div class="chip on">1. série</div><div class="chip">2. série</div><div class="chip">3. série</div></div>
    <div class="episodes">${[1, 2, 3, 4].map((n) => `<div class="episode"><b>S01E0${n}</b><small>Epizoda ${n}</small></div>`).join("")}</div>
    ${people(0, SERIES_PEOPLE)}</div>` },
};

function fit() {
  const tv = document.getElementById("tv");
  tv.style.transform = `translate(-50%,-50%) scale(${Math.min(innerWidth / 1920, (innerHeight - 40) / 1080)})`;
}
function render() {
  const key = views[location.hash.slice(1)] ? location.hash.slice(1) : "top";
  document.getElementById("tv").innerHTML = `<div class="backdrop"></div>${views[key].html()}`;
  document.getElementById("switch").innerHTML = Object.entries(views).map(([id, view]) => `<a href="#${id}" class="${id === key ? "on" : ""}">${view.label}</a>`).join("");
  fit();
  if (location.search.includes("shot")) document.getElementById("switch").style.display = "none";
}
addEventListener("hashchange", render);
addEventListener("resize", fit);
render();
