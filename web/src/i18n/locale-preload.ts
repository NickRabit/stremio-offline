/** Source of the classic script index.html loads before the main chunk. `chunks` maps a
 *  locale to its chunk's absolute URL. */
export function localePreloadSource(chunks: Record<string, string>): string {
  // ES2017 on purpose: the page runs this on the Safari 14 / Chrome 87 floor, before any module,
  // and modulepreload itself is missing there. No optional chaining, nullish coalescing, or globalThis.
  return `(function () {
  try {
    var chunks = ${JSON.stringify(chunks)};
    var supported = ["en"].concat(Object.keys(chunks));

    var find = function (list, predicate) {
      for (var index = 0; index < list.length; index += 1) {
        if (predicate(list[index])) return list[index];
      }
    };

    var detect = function (candidates, fallback) {
      var nav = typeof navigator === "undefined" ? null : navigator;
      var languages = nav && nav.languages && nav.languages.length ? nav.languages : [nav && nav.language];
      var tags = languages.filter(Boolean).map(function (tag) {
        return String(tag).toLowerCase().replace(/_/g, "-");
      });
      for (var index = 0; index < tags.length; index += 1) {
        var tag = tags[index];
        var exact = find(candidates, function (candidate) { return candidate.toLowerCase() === tag; });
        if (exact) return exact;
        var base = tag.split("-")[0];
        var language = find(candidates, function (candidate) {
          return candidate.toLowerCase().split("-")[0] === base;
        });
        if (language) return language;
      }
      return fallback;
    };

    var locale = null;
    try {
      var stored = localStorage.getItem("ui-language");
      if (supported.indexOf(stored) !== -1) locale = stored;
    } catch (storageError) {
      locale = null;
    }

    if (!locale && typeof stremioDesktop !== "undefined" && stremioDesktop && supported.indexOf(stremioDesktop.locale) !== -1) {
      locale = stremioDesktop.locale;
    }

    if (!locale) locale = detect(supported, "en");

    var url = chunks[locale];
    if (!url) return;

    var link = document.createElement("link");
    var relList = link.relList;
    if (relList && typeof relList.supports === "function" && relList.supports("modulepreload")) {
      link.setAttribute("rel", "modulepreload");
      link.setAttribute("href", url);
      document.head.appendChild(link);
    } else {
      fetch(url).catch(function () {});
    }
  } catch (error) {}
})();
`;
}
