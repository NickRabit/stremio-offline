/** Where the newest release of this project is announced. */
export const UPDATE_FEED_URL = "https://api.github.com/repos/NickRabit/stremio-offline/releases/latest";

/** Releases are linked only here, so a feed entry that answers with anything else is not trusted. */
const RELEASE_URL_PREFIX = "https://github.com/NickRabit/stremio-offline/releases/";

export interface Release {
  version: string;
  url: string;
}

/** The three numbers of a plain `x.y.z` (a leading `v` is the tag's habit), or null for anything
 *  else -- a pre-release, a build suffix, a word. */
export function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewer(a: [number, number, number], b: [number, number, number]): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

/** The release a GitHub feed entry names, or null when it is a draft, a pre-release, malformed
 *  or points somewhere other than this project's releases. */
export function readRelease(json: unknown): Release | null {
  if (typeof json !== "object" || json === null) return null;
  const record = json as Record<string, unknown>;
  if (record.draft === true || record.prerelease === true) return null;
  const version = record.tag_name;
  const url = record.html_url;
  if (typeof version !== "string" || typeof url !== "string") return null;
  if (!url.startsWith(RELEASE_URL_PREFIX)) return null;
  const parsed = parseVersion(version);
  // The page shows a version, not a tag.
  return parsed ? { version: parsed.join("."), url } : null;
}

/** The release behind `feedUrl` when it is newer than the running app, else null. Answers null
 *  rather than throwing for every failure: an update notice is never worth an error. */
export async function checkForUpdate(
  current: string,
  fetchImpl: typeof fetch,
  feedUrl: string,
  timeoutMs = 5_000,
): Promise<Release | null> {
  const running = parseVersion(current);
  if (!running) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(feedUrl, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": `Stremio-Offline/${current}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) return null;
    const release = readRelease(await response.json());
    if (!release) return null;
    const published = parseVersion(release.version);
    return published && isNewer(published, running) ? release : null;
  } catch {
    return null;
  }
}
