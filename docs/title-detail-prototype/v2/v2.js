// Study v2: real TMDB data (sample.js); the split buttons are the app's own markup.
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const I = {
  play: svg('<path d="M9 9.003a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997A1 1 0 0 1 9 14.996z"/><circle cx="12" cy="12" r="10"/>'),
  tri: svg('<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>'),
  down: svg('<path d="m6 9 6 6 6-6"/>'),
  right: svg('<path d="m9 18 6-6-6-6"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  restart: svg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>'),
  drive: svg('<path d="M10 16h.01"/><path d="M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M21.946 12.013H2.054"/><path d="M6 16h.01"/>'),
  dl: svg('<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>'),
  star: svg('<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>'),
  bell: svg('<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>'),
  ytplay: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="11" fill="#000000aa"/><path d="M10 8l6 4-6 4z" fill="#fff"/></svg>',
};
const S = window.SAMPLE;
const hm = (min) => `${Math.floor(min / 60)} h ${min % 60} min`;
const ini = (name) => name.split(" ").map((p) => p[0]).slice(0, 2).join("");
const person = (p) => `<button class="v2-person" title="Hledat „${p.name}“">${p.photo ? `<img src="${p.photo}" alt="">` : `<span class="ini">${ini(p.name)}</span>`}<strong>${p.name}</strong><small>${p.role}</small></button>`;
const typeLabel = { Trailer: "Trailer", Teaser: "Teaser", Featurette: "Ze zákulisí", Clip: "Ukázka", "Behind the Scenes": "Ze zákulisí" };

function view() {
  const people = [...S.crew.filter((c) => c.role === "Režie"), ...S.cast, ...S.crew.filter((c) => c.role !== "Režie")];
  return `<div class="v2">
  <section class="v2-hero" style="background-image:url(${S.backdrop})">
    <img class="v2-poster" src="${S.poster}" alt="">
    <div class="v2-copy">
      <div class="title-chips"><span class="pill">Film</span><div class="title-links"><a href="#">ČSFD</a><a href="#">TMDB</a><a href="#">IMDb</a></div></div>
      <h2>${S.title}</h2>
      <p class="v2-original">${S.original} · angličtina</p>
      <div class="v2-facts"><span>${S.year}</span><i></i><span>${hm(S.runtime)}</span><i></i><span>${S.genres.join(", ")}</span></div>
      <div class="v2-ratings">
        <span class="v2-rate age" title="Věková hranice (CZ)">${S.age}</span>
        <span class="v2-rate"><b class="imdb">IMDb</b>9,3</span>
        <span class="v2-rate"><b class="tmdb">TMDB</b>${String(S.tmdb).replace(".", ",")} <small>${(S.votes / 1000).toFixed(0)} tis.</small></span>
      </div>
      <p class="v2-desc">${S.overview}</p>
      <button class="v2-more">Více</button>
      <div class="v2-crewline">Režie <b>Frank Darabont</b> · Předloha <b>Stephen King</b></div>
      <div class="v2-actions">
        <div class="split-button"><button type="button" class="primary">${I.play} Přehrát</button><button type="button" class="split-button-toggle primary" title="Vybrat zdroj">${I.down}</button></div>
        <div class="split-button"><button type="button">${I.drive} Do knihovny</button><button type="button" class="split-button-toggle" title="Uložit jinam…">${I.down}</button></div>
        <div class="v2-secondary">
          <button class="v2-icon"><span>${I.tri}</span>Trailer</button>
          <button class="v2-icon"><span>${I.check}</span>Zhlédnuto</button>
          <button class="v2-icon"><span>${I.dl}</span>Do zařízení</button>
          <button class="v2-icon on"><span>${I.star}</span>Oblíbené</button>
        </div>
      </div>
      <dl class="v2-tech">
        <dt>Zdroj</dt><dd>Cineshare – Tišnov · 6,7 GB <button class="pick">36 dalších ${I.down}</button></dd>
        <dt>Video</dt><dd>2160p <span class="tag hdr">HDR10</span> <span class="tag">HEVC</span></dd>
        <dt>Zvuk</dt><dd>Čeština, Angličtina <span class="tag">DTS 5.1</span></dd>
        <dt>Titulky</dt><dd>Čeština, Angličtina · v souboru</dd>
        <dt>Soubor</dt><dd><span class="file">Vykoupeni.z.veznice.Shawshank.1994.2160p.UHD.BluRay.HDR10.CZ.EN.mkv</span></dd>
      </dl>
    </div>
  </section>
  <div class="v2-sections">
    <section class="v2-row"><h3><a href="#">Herci a tvůrci ${I.right}</a></h3><div class="v2-strip">${people.map(person).join("")}</div></section>
    <section class="v2-row"><h3>Trailery a bonusy</h3><div class="v2-strip">${S.videos.map((v) => `<button class="v2-video"><span class="thumb"><img src="${v.thumb}" alt="">${I.ytplay}</span><strong>${v.name}</strong><small>${typeLabel[v.type] ?? v.type}</small></button>`).join("")}</div></section>
    <section class="v2-row"><h3>Podobné tituly</h3><div class="v2-strip">${S.related.map((r) => `<button class="v2-rel"><img src="${r.poster}" alt=""><strong>${r.name}</strong><small>${r.year}</small></button>`).join("")}</div></section>
  </div></div>`;
}
document.getElementById("root").innerHTML = view();
