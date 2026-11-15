export interface ChildSession {
  child: boolean;
  catalogue: boolean;
}

type Rule = { method: string; pattern: RegExp };

const rule = (method: string, pattern: RegExp): Rule => ({ method, pattern });

const REFUSED_FOR_CHILD: readonly Rule[] = [
  rule("", /^\/api\/downloads(?:\/|$)/),
  rule("", /^\/api\/device-download(?:\/|$)/),
  rule("", /^\/api\/library\/folders$/),
  rule("", /^\/api\/links\/[^/]+\/[^/]+$/),
  rule("", /^\/api\/library\/links$/),
  rule("", /^\/api\/trailer\/[^/]+\/[^/]+$/),
  rule("", /^\/api\/library\/trailer$/),
  rule("", /^\/api\/meta\/[^/]+\/[^/]+\/extras$/),
  rule("", /^\/api\/person(?:\/|$)/),
  rule("GET", /^\/api\/follows\/calendar-feed$/),
  rule("POST", /^\/api\/follows\/calendar-feed$/),
  rule("POST", /^\/api\/follows\/[^/]+\/episodes\/[^/]+\/(?:skip|retry)$/),
  rule("PATCH", /^\/api\/settings$/),
  rule("PATCH", /^\/api\/search\/preferences$/),
  rule("PUT", /^\/api\/follows\/defaults$/),
  rule("PATCH", /^\/api\/auth\/password$/),
  rule("PATCH", /^\/api\/auth\/pin$/),
  rule("PUT", /^\/api\/addons\/order$/),
  rule("POST", /^\/api\/auth\/pair\/(?:inspect|approve|deny)$/),
];

const REFUSED_WITHOUT_CATALOGUE: readonly Rule[] = [
  rule("GET", /^\/api\/catalogs$/),
  rule("GET", /^\/api\/catalog$/),
  rule("GET", /^\/api\/search$/),
  rule("GET", /^\/api\/searchable$/),
  rule("", /^\/api\/search\/catalog(?:\/|$)/),
  rule("GET", /^\/api\/meta\/[^/]+\/[^/]+$/),
  rule("GET", /^\/api\/stream-sources\/[^/]+\/[^/]+$/),
  rule("GET", /^\/api\/streams\/[^/]+\/[^/]+$/),
  rule("GET", /^\/api\/subtitles\/[^/]+\/[^/]+$/),
  rule("GET", /^\/api\/addons$/),
  rule("", /^\/api\/watchlist$/),
  rule("", /^\/api\/source-profiles$/),
  rule("", /^\/api\/follows(?:\/|$)/),
];

let session: ChildSession | null = null;

/** The session the request layer reads. Set whenever the shell learns or loses its session. */
export function setChildSession(next: ChildSession | null): void {
  session = next;
}

export function childSession(): ChildSession | null {
  return session;
}

/** Whether a child client must not send this request. `path` is the URL path with the `/api`
 *  prefix, without a query. */
export function childRefuses(method: string, path: string, catalogue: boolean): boolean {
  const allMethods = (rules: readonly Rule[]) => rules.some((entry) =>
    (entry.method === "" || entry.method === method.toUpperCase()) && entry.pattern.test(path));
  return allMethods(REFUSED_FOR_CHILD) || (!catalogue && allMethods(REFUSED_WITHOUT_CATALOGUE));
}

/** The views a child may open. */
export function childViewAllowed(view: string, catalogue: boolean): boolean {
  return view === "home" || view === "library" || view === "search" || (view === "catalog" && catalogue);
}
