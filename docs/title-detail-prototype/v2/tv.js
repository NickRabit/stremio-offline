// Study v2 for Android TV, on real TMDB data (sample.js).
const S = window.SAMPLE;
const people = [...S.crew.filter((c) => c.role === "Režie"), ...S.cast];
const hero = (focus) => `<div class="eyebrow">CINESHARE · FILM</div><h1>${S.title}</h1>
  <div class="orig">${S.original} · angličtina</div>
  <div class="facts">${S.year} · ${Math.floor(S.runtime / 60)} h ${S.runtime % 60} min · ${S.genres.join(", ")}</div>
  <div class="ratings"><span class="rate age">${S.age}</span><span class="rate"><b class="imdb">IMDb</b>9,3</span><span class="rate"><b class="tmdb">TMDB</b>${String(S.tmdb).replace(".", ",")}</span></div>
  <p class="desc">${S.overview}</p>
  <div class="actions"><div class="btn primary ${focus ? "focus" : ""}">▶ Přehrát</div><div class="btn">Zdroje · 36</div><div class="btn">⬇ Do knihovny</div>
    <div class="ic"><span>↺</span>Od začátku</div><div class="ic"><span>✓</span>Zhlédnuto</div><div class="ic"><span>☆</span>Oblíbené</div></div>
  <dl class="tech"><dt>Přehraje se</dt><dd>Cineshare – Tišnov · 6,7 GB</dd><dt>Video</dt><dd>2160p<span class="tag hdr">HDR10</span><span class="tag">HEVC</span></dd><dt>Zvuk</dt><dd>Čeština, Angličtina<span class="tag">DTS 5.1</span></dd><dt>Titulky</dt><dd>Čeština, Angličtina</dd></dl>`;
const peopleRow = (focus) => `<div class="row"><h2>Herci a tvůrci</h2><div class="strip">${people.slice(0, 10).map((p, i) => `<div class="person ${i === focus ? "focus" : ""}"><img src="${p.photo}" alt=""><strong>${p.name}</strong><small>${p.role}</small></div>`).join("")}</div></div>`;
const videos = `<div class="row"><h2>Trailery a bonusy</h2><div class="strip">${S.videos.map((v) => `<div class="video"><img src="${v.thumb}" alt=""><strong>${v.name}</strong><small>${v.type}</small></div>`).join("")}</div></div>`;
const views = {
  top: { label: "Úvod", html: () => `<div class="content">${hero(true)}${peopleRow(-1)}</div>` },
  cast: { label: "Herci", html: () => `<div class="content" style="transform:translateY(-500px)">${hero(false)}${peopleRow(1)}${videos}</div>` },
};
function fit() { document.getElementById("tv").style.transform = `translate(-50%,-50%) scale(${Math.min(innerWidth / 1920, (innerHeight - 40) / 1080)})`; }
function render() {
  const key = views[location.hash.slice(1)] ? location.hash.slice(1) : "top";
  document.getElementById("tv").innerHTML = `<div class="backdrop" style="background-image:url(${S.backdrop})"></div>${views[key].html()}`;
  document.getElementById("switch").innerHTML = location.search.includes("shot") ? "" : Object.entries(views).map(([id, v]) => `<a href="#${id}" class="${id === key ? "on" : ""}">${v.label}</a>`).join("");
  fit();
}
addEventListener("hashchange", render); addEventListener("resize", fit); render();
