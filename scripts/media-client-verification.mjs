#!/usr/bin/env node
/**
 * Production media-client verification: does the shipped application, over its
 * own HTTP API, browse a large Jellyfin/Emby library and play a real remote
 * original without touching the provider's history?
 *
 * The runner starts its own disposable build of the application on a free
 * loopback port, puts an observed proxy in front of every provider, and drives
 * the same routes the browser uses. It writes one JSON report; it never prints
 * credentials, provider addresses, source ids or titles, and it never talks to a
 * running instance or an existing data directory.
 *
 * This is HTTP-level evidence. It is not a rendered browser or TV decoder pass.
 * See docs/media-client-verification.md for the CLI and the report contract.
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  FIXTURE_LANE,
  FixtureError,
  createObservedProxy,
  createSyntheticProvider,
  freePort,
  labelHash,
  parseRunnerArgs,
  readBounded,
  sha256Hex,
  startDisposableApp,
  usageText,
  validateFixtureConfig,
} from "./media-client-verification-fixtures.mjs";

const execFileAsync = promisify(execFile);

export const REPORT_VERSION = 1;
export const MAX_REPORT_EVENTS = 40;
export const BROWSE_LIMIT = 60;
/** What this report may and may not be read as, quoted by the documentation. */
export const RUNNER_FACTS = "HTTP-level evidence; media and history are never written upstream";
const BROWSE_PAGE_SLACK = 1;
const BROWSE_PAGES_PER_ITEM = 3;
const RECOVERY_ATTEMPT_MAX = 8;
const RATE_LIMIT_REQUEST_MAX = 6;
const CANCEL_DEFAULT_DELAY_MS = 3_000;
const SEGMENT_READ_MAX = 512 * 1024;

/** The capabilities a Chromium-shaped browser claims: video and audio the web
 *  player decodes itself, no container list (that shortcut belongs to the native
 *  client). Sent explicitly, so the server's direct/remux decision is made for a
 *  real client rather than for an empty object. */
export const BROWSER_CAPABILITIES = Object.freeze({
  h264: true, vp8: true, vp9: true, aac: true, mp3: true, opus: true, vorbis: true, hevc: false, av1: false,
});

export const PASS = "pass";
export const FAIL = "fail";
export const SKIPPED = "skipped";
export const UNMEASURED = "unmeasured";

/** The reusable contract this report was produced under, so a reader can see which
 *  functions the runner exposes without opening the scripts. */
export const EXPORTED_CONTRACT = Object.freeze({
  "fixtures.parseRunnerArgs": "(argv: string[]) => { mode, fixturePath?, outputPath?, items, pages, delayMs }",
  "fixtures.validateFixtureConfig": "(raw: string | object) => { providers: [{ provider, baseUrl, username, password, itemIds }] }",
  "fixtures.validateUpstreamUrl": "(raw: string, field: string) => string",
  "fixtures.createObservedProxy": "({ upstream, label?, maxEvents?, upstreamDeadlineMs? }) => { baseUrl, port, stats(), counters(category, lane?), faultServed(category, kind), dials(category), setLatency(), armFault(), clearFaults(), reset(), pending(), close() }",
  "fixtures.createSyntheticProvider": "({ items, folders?, provider?, version?, pageDelayMs? }) => { baseUrl, port, serverId, accountId, libraryId, catalogueTotal, stats(), close() }",
  "fixtures.createAppClient": "(baseUrl: string, cookie?: string) => { request(target, { method, body, headers, timeoutMs, signal }), bytes(target, { maxBytes, timeoutMs, headers, signal }) }",
  "fixtures.disposableAppEnv": "(base: Record<string,string>, parentEnv?) => { env, stripped: string[] }",
  "fixtures.startDisposableApp": "({ repoRoot, port?, logLevel? }) => { baseUrl, port, dir, dataDir, logPath, keyFile, libraryRoots, pid, version, strippedInheritedEnv, request(), bytes(), stop() }",
  "fixtures.classifyUpstreamRequest": "({ method, path, search? }) => { category, allowed, mutation? }",
  "runner.createFixtureClient": "({ observer, username, password, provider, timeoutMs? }) => { authenticate(), userData(), playbackInfo(), ancestorIds(), original(), failures() }",
  "runner.classifyContentProbe": "(probe) => { status: pass|fail|unmeasured, reason }",
  "runner.playlistChildren": "(text, playlistUrl) => { variant?, init?, segment? }",
  "runner.rangeProbe": "(length) => { offset, window, range, nonzero }",
  "runner.runVerification": "(config, { fixture?, repoRoot?, folders?, appLogLevel? }) => Report",
  "runner.assertReportSafe": "(report) => report",
  "runner.main": "(argv?: string[]) => Promise<number>",
});

/**
 * The variant playlist, init file and first media segment a playlist names,
 * resolved against the playlist's own address the way a player resolves them.
 * The subscriber URI of a master playlist is not a variant, and an init segment
 * is not media.
 */
export function playlistChildren(text, playlistUrl) {
  const source = String(text ?? "");
  const lines = source.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const variant = lines.find((line) => !line.startsWith("#") && /^[A-Za-z0-9_.-]+\.m3u8$/.test(line));
  const files = lines.filter((line) => !line.startsWith("#"));
  // An fmp4 playlist declares its init segment in a tag, not as a plain line.
  const init = files.find((line) => /^init\b/.test(line)) ?? /#EXT-X-MAP:[^\n]*URI="([^"]+)"/.exec(source)?.[1];
  const segment = files.find((line) => /\.(m4s|ts|mp4)$/.test(line) && !/^init\b/.test(line));
  const base = new URL(playlistUrl);
  const resolve = (name) => (name === undefined ? undefined : new URL(name, base).pathname);
  return { variant: resolve(variant), init: resolve(init), segment: resolve(segment) };
}

/**
 * The byte range the content check asks for: a nonzero start where the file is
 * big enough for one, the whole body when it is not, and a bounded window
 * everywhere so no comparison ever pulls a whole film through the harness.
 */
export function rangeProbe(length) {
  const known = Number.isFinite(length) && length > 0;
  const offset = known && length > 4096 ? Math.min(Math.floor(length / 2), 1_000_000) : 0;
  const window = known ? clamp(length - offset, 1, 65_536) : 65_536;
  return { offset, window, range: `bytes=${offset}-${offset + window - 1}`, nonzero: offset > 0 };
}

/**
 * A report may carry aggregates, labels and booleans. It may not carry an
 * address, a credential, a session, an upstream id or a media path, so the last
 * step before the file is written refuses a report that grew one.
 */
export function assertReportSafe(report) {
  const suspicious = [
    [/https?:\/\//i, "an address"],
    [/\bpath=/i, "a cookie attribute"],
    [/\bcookie\b/i, "cookie wording"],
    [/\bpassword\b/i, "password wording"],
    [/\bbearer\b/i, "bearer wording"],
    [/stremio_offline_session/i, "a session name"],
  ];
  const walk = (value, keyPath) => {
    if (typeof value === "string") {
      for (const [pattern, what] of suspicious) {
        if (pattern.test(value)) throw new FixtureError("unsafe-report", `the report carries ${what} at ${keyPath}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${keyPath}[${index}]`));
      return;
    }
    if (value && typeof value === "object") for (const [key, entry] of Object.entries(value)) walk(entry, `${keyPath}.${key}`);
  };
  walk(report, "report");
  return report;
}

/** Collects every check exactly once, and nothing else. */
class Recorder {
  constructor() {
    this.checks = [];
    this.caveats = [];
  }

  record(id, status, detail = {}) {
    this.checks.push({ id, status, detail });
    return status;
  }

  pass(id, detail) { return this.record(id, PASS, detail); }
  fail(id, detail) { return this.record(id, FAIL, detail); }
  skip(id, reason, detail = {}) { return this.record(id, SKIPPED, { reason, ...detail }); }
  unmeasured(id, reason, detail = {}) { return this.record(id, UNMEASURED, { reason, ...detail }); }
  caveat(note) { this.caveats.push(note); }
  get failed() { return this.checks.filter((check) => check.status === FAIL); }

  get skips() {
    return this.checks.filter((check) => check.status === SKIPPED).map((check) => ({ id: check.id, reason: check.detail.reason }));
  }

  get unmeasuredChecks() {
    return this.checks.filter((check) => check.status === UNMEASURED).map((check) => ({ id: check.id, reason: check.detail.reason }));
  }
}

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

const jsonOf = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** One buffered application call. A worker only ever sees a status, headers and a
 *  parsed body. */
const appCall = async (app, target, options = {}) => {
  const response = await app.request(target, options);
  const text = response.text();
  return { status: response.status, headers: response.headers, text, body: jsonOf(text) };
};

/**
 * Provider reads taken with the harness's own lane, so the fixture's traffic never
 * pollutes the counters that describe what the application did.
 *
 * Every call owns a finite deadline that covers its body and composes the caller's
 * own signal. Nothing here throws except `authenticate`, which has to report a
 * refused sign-in: a read that fails or runs out of time answers `undefined` and
 * records why, so a missing comparison stays missing instead of becoming a pass.
 */
export function createFixtureClient({ observer, username, password, provider, timeoutMs = 20_000 }) {
  const lane = { "x-mcv-lane": FIXTURE_LANE };
  const failures = [];
  let accessToken;

  const withDeadline = (options) => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new FixtureError("fixture-timeout", "the fixture read ran out of time")),
      options.timeoutMs ?? timeoutMs,
    );
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) controller.abort(options.signal.reason);
    return {
      controller,
      release: () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      },
    };
  };

  const read = async (target, options = {}) => {
    const { controller, release } = withDeadline(options);
    try {
      const headers = {
        ...lane,
        accept: "application/json",
        authorization: 'MediaBrowser Client="media-client-verification", Device="harness", DeviceId="mcv-fixture", Version="1"' + (accessToken ? `, Token="${accessToken}"` : ""),
        ...(accessToken ? { "x-emby-token": accessToken } : {}),
        ...(options.headers ?? {}),
      };
      if (options.body !== undefined) headers["content-type"] = "application/json";
      const response = await fetch(new URL(target, observer.baseUrl), {
        method: options.method ?? "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      if (options.maxBytes !== undefined) {
        const bounded = await readBounded(response, options.maxBytes);
        return { status: response.status, contentRange: response.headers.get("content-range"), bytes: bounded.bytes, truncated: bounded.truncated };
      }
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      return { status: response.status, body };
    } catch (error) {
      const reason = error instanceof FixtureError ? error.code : "fixture-read-failed";
      failures.push(reason);
      return { status: 0, body: undefined, bytes: Buffer.alloc(0), failure: reason };
    } finally {
      release();
    }
  };

  return {
    provider,
    failures: () => failures.slice(),

    async authenticate() {
      const result = await read("/Users/AuthenticateByName", { method: "POST", body: { Username: username, Pw: password } });
      if (result.status !== 200 || typeof result.body?.AccessToken !== "string") {
        throw new FixtureError("fixture-auth", `the fixture account was refused by the provider (${result.status})`);
      }
      accessToken = result.body.AccessToken;
      return { userId: result.body.User?.Id, serverId: result.body.User?.ServerId };
    },

    /** The five provider history fields, read and never written. */
    async userData(userId, itemId) {
      const result = await read(`/Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(itemId)}?Fields=UserData`);
      if (result.status !== 200 || typeof result.body?.UserData !== "object" || result.body.UserData === null) return undefined;
      const data = result.body.UserData;
      return {
        PlaybackPositionTicks: data.PlaybackPositionTicks ?? null,
        Played: data.Played ?? null,
        PlayCount: data.PlayCount ?? null,
        LastPlayedDate: data.LastPlayedDate ?? null,
        IsFavorite: data.IsFavorite ?? null,
      };
    },

    async playbackInfo(userId, itemId) {
      const result = await read(`/Items/${encodeURIComponent(itemId)}/PlaybackInfo?UserId=${encodeURIComponent(userId)}`);
      if (result.status !== 200 || !Array.isArray(result.body?.MediaSources)) return undefined;
      return result.body.MediaSources
        .filter((source) => source && typeof source.Id === "string" && source.Protocol === "File")
        .map((source) => ({
          id: source.Id,
          name: typeof source.Name === "string" ? source.Name : undefined,
          container: typeof source.Container === "string" ? source.Container : undefined,
          size: typeof source.Size === "number" ? source.Size : undefined,
          videoCodec: source.MediaStreams?.find((track) => track.Type === "Video")?.Codec,
        }));
    },

    async ancestorIds(userId, itemId) {
      const result = await read(`/Items/${encodeURIComponent(itemId)}/Ancestors?UserId=${encodeURIComponent(userId)}`);
      if (result.status !== 200 || !Array.isArray(result.body)) return undefined;
      return result.body.map((entry) => entry?.Id).filter((id) => typeof id === "string");
    },

    async original(itemId, mediaSourceId, range) {
      const result = await read(`/Videos/${encodeURIComponent(itemId)}/stream?Static=true&MediaSourceId=${encodeURIComponent(mediaSourceId)}`, {
        headers: range ? { range } : {},
        maxBytes: SEGMENT_READ_MAX,
      });
      if (result.status === 0) return undefined;
      return { status: result.status, contentRange: result.contentRange, bytes: result.bytes, truncated: result.truncated };
    },
  };
}

/** How many FFmpeg/FFprobe processes the disposable application currently owns, or
 *  null when the platform cannot say. A null is reported as a null, never guessed. */
async function appChildProcessCount(pid) {
  try {
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "ppid=,comm="], { maxBuffer: 8 * 1024 * 1024 });
    return stdout.split("\n").filter((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      return Boolean(match) && Number(match[1]) === pid && /ffmpeg|ffprobe/i.test(match[2]);
    }).length;
  } catch {
    return null;
  }
}

const playbackSessionIds = (diagnostics) =>
  Array.isArray(diagnostics?.playback?.sessions)
    ? diagnostics.playback.sessions.map((session) => session?.id).filter((id) => typeof id === "string")
    : [];

const memoryMb = (diagnostics) => (typeof diagnostics?.memoryMb === "number" ? diagnostics.memoryMb : undefined);

/** The client sees its own abort at once; the observer's socket teardown lands a
 *  moment later. Counters are read only once nothing is in flight. */
const settleObserver = async (observer, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (observer.pending() > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  return observer.pending();
};

/** What one ranged content comparison proved. A pass requires the application to
 *  answer 206 with the exact nonzero range that was asked for, and the provider to
 *  answer the same range with the same length and the same bytes. Anything that
 *  cannot be compared is UNMEASURED; anything that disagrees is FAIL. */
export function classifyContentProbe({
  requestedRange,
  responseStatus,
  responseRange,
  responseBytes,
  providerStatus,
  providerRange,
  providerBytes,
  providerHash,
  responseHash,
}) {
  const wanted = /^bytes=(\d+)-(\d+)$/.exec(String(requestedRange ?? ""));
  if (!wanted) return { status: FAIL, reason: "the harness asked for no usable range" };
  const start = Number(wanted[1]);
  const end = Number(wanted[2]);
  const shape = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(responseRange ?? ""));
  if (responseStatus !== 206) return { status: FAIL, reason: `the resource answered ${responseStatus} instead of 206` };
  if (!shape) return { status: FAIL, reason: "the 206 carried no usable Content-Range" };
  if (Number(shape[1]) !== start || Number(shape[2]) !== end) {
    return { status: FAIL, reason: "the Content-Range does not name the range that was asked for" };
  }
  if (Number(shape[2]) - Number(shape[1]) + 1 !== responseBytes) {
    return { status: FAIL, reason: "the Content-Range and the delivered length disagree" };
  }
  // The range was served correctly, but a zero start proves nothing about offsets,
  // so the comparison this check exists for never happened.
  if (start <= 0) return { status: UNMEASURED, reason: "the resource is too small for a nonzero range" };
  if (providerStatus === undefined || providerBytes === undefined) {
    return { status: UNMEASURED, reason: "the same range could not be read from the provider" };
  }
  if (providerStatus !== 206) return { status: FAIL, reason: `the provider answered ${providerStatus} for the same range` };
  if (providerRange !== responseRange) return { status: FAIL, reason: "the provider reported a different Content-Range" };
  if (providerBytes !== responseBytes) return { status: FAIL, reason: "the provider delivered a different length" };
  if (providerHash !== responseHash) return { status: FAIL, reason: "the bytes differ from the provider's for the same range" };
  return { status: PASS, reason: "the same nonzero range arrived byte for byte from the provider" };
}

/**
 * The production playback profile: a real provider behind an observed proxy, the
 * application attached to it, and every supplied item driven through the routes
 * the browser uses.
 */
async function runFixtureProfile({ app, config, observers, recorder, fixture }) {
  for (let index = 0; index < fixture.providers.length; index += 1) {
    const entry = fixture.providers[index];
    const observer = observers[index];
    const providerLabel = `provider-${index + 1}`;
    try {
      await runOneProvider({ app, config, observer, providerLabel, entry, index, recorder });
    } catch (error) {
      recorder.fail(`${providerLabel}.unexpected`, { problem: error instanceof FixtureError ? error.code : "internal" });
    }
  }
}

async function runOneProvider({ app, config, observer, providerLabel, entry, index, recorder }) {
  const client = createFixtureClient({ observer, username: entry.username, password: entry.password, provider: entry.provider });
  let identity;
  try {
    identity = await client.authenticate();
  } catch (error) {
    recorder.fail(`${providerLabel}.fixture-signin`, { problem: error instanceof FixtureError ? error.code : "internal" });
    return;
  }
  recorder.pass(`${providerLabel}.fixture-signin`, {
    accountLabel: labelHash(identity.userId ?? "unknown"),
    serverLabel: labelHash(identity.serverId ?? "unknown"),
  });

  const created = await appCall(app, "/api/media-servers", {
    method: "POST",
    body: {
      provider: entry.provider,
      name: providerLabel,
      baseUrl: observer.baseUrl,
      allowLan: false,
      allowLoopback: true,
      username: entry.username,
      password: entry.password,
    },
    timeoutMs: 60_000,
  });
  if (created.status !== 201 || typeof created.body?.id !== "string") {
    recorder.fail(`${providerLabel}.connection-create`, { status: created.status });
    return;
  }
  recorder.pass(`${providerLabel}.connection-create`, { status: created.status, provider: entry.provider });
  const connectionId = created.body.id;

  const discovered = await appCall(app, `/api/media-servers/${encodeURIComponent(connectionId)}/libraries`, { timeoutMs: 60_000 });
  const providerLibraries = Array.isArray(discovered.body?.items) ? discovered.body.items : [];
  if (discovered.status !== 200 || providerLibraries.length === 0) {
    recorder.fail(`${providerLabel}.library-discover`, { status: discovered.status, libraries: providerLibraries.length });
    return;
  }
  recorder.pass(`${providerLabel}.library-discover`, {
    status: discovered.status,
    libraries: providerLibraries.length,
    types: providerLibraries.map((library) => library.type),
  });

  const attached = [];
  for (const library of providerLibraries.slice(0, 4)) {
    const response = await appCall(app, `/api/media-servers/${encodeURIComponent(connectionId)}/libraries`, {
      method: "POST",
      body: { remoteId: library.id },
      timeoutMs: 60_000,
    });
    if (response.status === 201 && typeof response.body?.id === "string") attached.push(response.body.id);
  }
  if (attached.length === 0) {
    recorder.fail(`${providerLabel}.library-attach`, { attempted: Math.min(providerLibraries.length, 4), attached: 0 });
    return;
  }
  recorder.pass(`${providerLabel}.library-attach`, { attempted: Math.min(providerLibraries.length, 4), attached: attached.length });

  const visible = await appCall(app, "/api/remote-libraries");
  const visibleLibraries = Array.isArray(visible.body?.libraries) ? visible.body.libraries : [];
  const visibleIds = visibleLibraries.map((library) => library.id);
  const modes = new Map(visibleLibraries.map((library) => [library.id, library.browseMode]));
  recorder.record(`${providerLabel}.visible-libraries`, attached.every((id) => visibleIds.includes(id)) ? PASS : FAIL, {
    attached: attached.length,
    visible: visibleIds.length,
  });

  for (let itemIndex = 0; itemIndex < entry.itemIds.length; itemIndex += 1) {
    const itemId = entry.itemIds[itemIndex];
    const itemLabel = `${providerLabel}.item-${itemIndex + 1}`;
    try {
      await verifyItem({ app, config, client, identity, observer, attached, modes, itemId, itemLabel, recorder, providerIndex: index });
    } catch (error) {
      recorder.fail(`${itemLabel}.unexpected`, { problem: error instanceof FixtureError ? error.code : "internal" });
    }
  }

  for (const mode of ["direct", "remux", "transcode"]) {
    const prepared = recorder.checks.filter((check) => check.id.startsWith(`${providerLabel}.`) && check.status === PASS
      && check.detail.mode === mode && /\.(playback-start|second-version)$/.test(check.id));
    const proven = prepared.some((check) => {
      const contentId = check.id.replace(/\.playback-start$/, ".content").replace(/\.second-version$/, ".second.content");
      return recorder.checks.some((content) => content.id === contentId && content.status === PASS);
    });
    recorder.record(`${providerLabel}.transport-${mode}`, proven ? PASS : (prepared.length ? UNMEASURED : SKIPPED), {
      prepared: prepared.length, bytesVerified: proven,
      reason: proven ? undefined : "No selected fixture version completed byte verification in this mode.",
      decoderMeasured: false,
    });
  }

  const refused = observer.stats().refused;
  const mutations = Object.values(refused).reduce((total, value) => total + value, 0);
  recorder.record(`${providerLabel}.no-prohibited-mutation`, mutations === 0 ? PASS : FAIL, { refused: mutations, refusedBy: refused });
  // A fixture read that failed means some comparison above had no data. It is
  // never a pass, and never hidden: the code names what could not be read.
  const readFailures = client.failures();
  recorder.record(`${providerLabel}.fixture-reads`,
    readFailures.length === 0 ? PASS : UNMEASURED,
    readFailures.length === 0
      ? { reads: "all fixture reads answered" }
      : { reason: "a fixture read did not answer, so at least one comparison had no data", codes: [...new Set(readFailures)] });
}

/** The item must be a member of a browsed page before it is played; the explicit
 *  detail route is the fallback that still names the owning library. */
async function locateItem({ app, attached, modes, itemId }) {
  let pagesRead = 0;
  for (const libraryId of attached) {
    const mode = modes.get(libraryId) === "folders" ? "folders" : "titles";
    let cursor;
    for (let pageIndex = 0; pageIndex < BROWSE_PAGES_PER_ITEM; pageIndex += 1) {
      const query = new URLSearchParams({ limit: String(BROWSE_LIMIT), mode });
      if (cursor) query.set("cursor", cursor);
      const page = await appCall(app, `/api/remote-libraries/${encodeURIComponent(libraryId)}/browse?${query}`);
      if (page.status !== 200 || !Array.isArray(page.body?.items)) break;
      pagesRead += 1;
      if (page.body.items.some((item) => item?.id === itemId)) return { libraryId, mode, pagesRead };
      cursor = page.body.cursor;
      if (!cursor) break;
    }
  }
  for (const libraryId of attached) {
    const detail = await appCall(app, `/api/remote-libraries/${encodeURIComponent(libraryId)}/items/${encodeURIComponent(itemId)}`);
    if (detail.status === 200) return { libraryId, mode: "titles", pagesRead, via: "detail-only" };
  }
  return undefined;
}

async function verifyItem({ app, config, client, identity, observer, attached, modes, itemId, itemLabel, recorder, providerIndex }) {
  const idHash = labelHash(itemId);
  const located = await locateItem({ app, attached, modes, itemId });
  if (!located) {
    recorder.skip(`${itemLabel}.browse-membership`, "the supplied item was in no attached library", { itemHash: idHash });
    return;
  }
  if (located.via === "detail-only") {
    // The item was resolved, but not as a member of a page this run browsed: a
    // membership claim would be wrong, and so would a failure.
    recorder.skip(`${itemLabel}.browse-membership`, "the item was not on the browsed pages; its detail route named the library", {
      pagesRead: located.pagesRead,
      itemHash: idHash,
    });
  } else {
    recorder.record(`${itemLabel}.browse-membership`, PASS, { pagesRead: located.pagesRead, via: "browse", itemHash: idHash });
  }
  const libraryId = located.libraryId;
  app.remoteLibraryId ??= libraryId;

  const detail = await appCall(app, `/api/remote-libraries/${encodeURIComponent(libraryId)}/items/${encodeURIComponent(itemId)}`);
  if (detail.status !== 200 || !detail.body?.item) {
    recorder.fail(`${itemLabel}.detail`, { status: detail.status });
    return;
  }
  recorder.pass(`${itemLabel}.detail`, { type: detail.body.item.type, itemHash: idHash });

  const listed = await appCall(app, `/api/remote-libraries/${encodeURIComponent(libraryId)}/items/${encodeURIComponent(itemId)}/sources`);
  const streams = Array.isArray(listed.body?.streams) ? listed.body.streams : [];
  if (listed.status !== 200 || streams.length === 0) {
    recorder.fail(`${itemLabel}.sources-listing`, { status: listed.status, streams: streams.length });
    return;
  }
  const remote = streams.filter((stream) => stream.kind === "remote" && stream.playable === true && typeof stream.sourceId === "string" && stream.remoteItem);
  const capabilities = streams[0].capabilities ?? {};
  const readOnly = capabilities.rename === false && capabilities.move === false && capabilities.delete === false
    && capabilities.identify === false && capabilities.writeArtwork === false && capabilities.downloadToDevice === false;
  recorder.record(`${itemLabel}.sources-shape`, remote.length === streams.length && readOnly ? PASS : FAIL, {
    streams: streams.length,
    remote: remote.length,
    providerTagged: streams.filter((stream) => typeof stream.provider === "string").length,
    readonly: readOnly,
    withExternalSubtitles: streams.filter((stream) => Array.isArray(stream.subtitles) && stream.subtitles.length > 0).length,
  });
  if (remote.length === 0) return;

  const versions = (await client.playbackInfo(identity.userId, itemId)) ?? [];
  const before = await client.userData(identity.userId, itemId);
  const ancestors = await client.ancestorIds(identity.userId, itemId);
  const facts = {
    providerVersions: versions.length,
    ancestorLevels: Array.isArray(ancestors) ? ancestors.length : null,
    userDataObserved: before !== undefined,
    sizesReported: versions.filter((version) => typeof version.size === "number").length,
  };

  const chosen = remote[0];
  if (providerIndex === 0 && app.cancelDone !== true) {
    app.cancelDone = true;
    // Run before the first inspection so its metadata cache is genuinely cold.
    await verifyCancellation({ app, observer, itemLabel, sourceId: chosen.sourceId,
      recorder, delayMs: config.delayMs, inspectionWorked: true });
  }
  const inspected = await appCall(app, "/api/inspect", { method: "POST", body: { sourceId: chosen.sourceId }, timeoutMs: 120_000 });
  const inspection = {
    status: inspected.status,
    hasDuration: typeof inspected.body?.duration === "number",
    subtitleTracks: Array.isArray(inspected.body?.subtitleTracks) ? inspected.body.subtitleTracks.length : null,
    videoCodecReported: typeof inspected.body?.video?.codec === "string",
    audioTracks: Array.isArray(inspected.body?.audioTracks) ? inspected.body.audioTracks.length : null,
  };
  // A probe that reports neither a video codec nor a single audio track did not
  // read the file, whatever status it answered with.
  const inspectedSomething = inspection.videoCodecReported || (inspection.audioTracks ?? 0) > 0;
  recorder.record(`${itemLabel}.inspect`, inspected.status === 200 && inspection.hasDuration && inspectedSomething ? PASS : FAIL, {
    ...inspection,
    inspectedSomething,
  });

  app.costProviders ??= new Set();
  if (!app.costProviders.has(providerIndex)) {
    app.costProviders.add(providerIndex);
    const detailBefore = observer.counters("detail").starts;
    const versionsBefore = observer.counters("versions").starts;
    const wrote = await appCall(app, `/api/remote-libraries/${encodeURIComponent(libraryId)}/items/${encodeURIComponent(itemId)}/state`, {
      method: "PATCH", body: { position: 0, duration: inspected.body?.duration ?? 0, mediaSourceId: chosen.remoteItem.mediaSourceId },
    });
    recorder.record(`${itemLabel}.progress-write-cost`, wrote.status === 200 ? PASS : FAIL, {
      status: wrote.status, samples: 1,
      detailRequests: observer.counters("detail").starts - detailBefore,
      versionRequests: observer.counters("versions").starts - versionsBefore,
      note: "Observed warm metadata cost of one local progress save; no performance budget asserted.",
    });
  }

  const started = await appCall(app, "/api/playback", {
    method: "POST",
    body: { sourceId: chosen.sourceId, capabilities: BROWSER_CAPABILITIES, time: 0 },
    timeoutMs: 180_000,
  });
  if (started.status !== 201 || typeof started.body?.id !== "string" || typeof started.body?.url !== "string") {
    recorder.fail(`${itemLabel}.playback-start`, { status: started.status });
    // Everything that needs a session is named as skipped rather than left out:
    // an absent check and a passed check must never look alike.
    for (const dependent of ["content", "seek-api", "track-change", "external-subtitle", "embedded-subtitle", "local-resume", "local-resume-reopen", "local-resume-version-tag-write", "second-version", "session-stopped"]) {
      recorder.skip(`${itemLabel}.${dependent}`, "no playback session was created");
    }
    await verifyRecovery({ app, observer, itemLabel, sourceId: chosen.sourceId, libraryId, recorder, delayMs: config.delayMs });
    return;
  }
  const session = started.body;
  recorder.pass(`${itemLabel}.playback-start`, {
    mode: session.mode,
    playlist: session.playlist === true,
    audioTracks: Array.isArray(session.audioTracks) ? session.audioTracks.length : null,
    subtitleTracks: Array.isArray(session.subtitleTracks) ? session.subtitleTracks.length : null,
    hardware: session.hardware === true,
  });

  const live = playbackSessionIds((await appCall(app, "/api/diagnostics")).body);
  recorder.record(`${itemLabel}.session-live`, live.includes(session.id) ? PASS : FAIL, { sessions: live.length });

  let active = session;
  try {
    await verifyContent({ app, client, itemId, itemLabel, session, mediaSourceId: chosen.remoteItem.mediaSourceId, versions, recorder });
    active = await verifySeek({ app, itemLabel, session, recorder });
    await verifyTrack({ app, itemLabel, session: active, recorder });
    await verifyExternalSubtitle({ app, itemLabel, streams: remote, recorder });
    await verifySidecar({ app, session: active, itemLabel, recorder });
    await verifyResume({ app, itemLabel, session: active, chosen, versions, recorder });
    await verifySecondVersion({ app, client, itemId, itemLabel, remote, versions, recorder });
    const mp4Alternate = remote.slice(1).find((stream) => versions.some((version) => version.id === stream.remoteItem.mediaSourceId && version.container?.toLowerCase() === "mp4"));
    if (mp4Alternate) await verifySecondVersion({ app, client, itemId, itemLabel: `${itemLabel}.direct-alternate`, remote: [remote[0], mp4Alternate], versions, recorder });

    await verifyRecovery({ app, observer, itemLabel, sourceId: chosen.sourceId, libraryId, recorder, delayMs: config.delayMs });
  } finally {
    const stopped = await appCall(app, `/api/playback/${encodeURIComponent(session.id)}`, { method: "DELETE", timeoutMs: 30_000 });
    const after = playbackSessionIds((await appCall(app, "/api/diagnostics")).body);
    const again = await appCall(app, `/api/playback/${encodeURIComponent(session.id)}`, { method: "DELETE", timeoutMs: 30_000 });
    recorder.record(`${itemLabel}.session-stopped`, stopped.status === 204 && !after.includes(session.id) && again.status === 404 ? PASS : FAIL, {
      stopStatus: stopped.status,
      sessionsAfter: after.length,
      repeatStatus: again.status,
    });
  }

  const afterData = await client.userData(identity.userId, itemId);
  const fields = ["PlaybackPositionTicks", "Played", "PlayCount", "LastPlayedDate", "IsFavorite"];
  const observed = before !== undefined && afterData !== undefined;
  const unchanged = observed && fields.every((field) => Object.is(before[field], afterData[field]));
  recorder.record(`${itemLabel}.provider-userdata-unchanged`, observed ? (unchanged ? PASS : FAIL) : UNMEASURED, {
    reason: observed ? undefined : "the provider did not report UserData for this item",
    fieldsCompared: fields.length,
    ...facts,
    fixtureReadFailures: client.failures().length,
  });
}

/** A direct source has to answer a nonzero range with the exact bytes the provider
 *  holds, and a converted one has to hand over a real segment rather than a
 *  playlist. */
async function verifyContent({ app, client, itemId, itemLabel, session, mediaSourceId, versions, recorder }) {
  if (session.playlist === true || /\.m3u8(\?|$)/.test(session.url)) return verifyHlsContent({ app, itemLabel, session, recorder });
  const head = await app.request(session.url, { method: "HEAD", timeoutMs: 30_000 });
  const length = Number(head.headers.get("content-length") ?? Number.NaN);
  const { range, nonzero } = rangeProbe(length);
  let ranged;
  try {
    ranged = await app.bytes(session.url, { headers: { range }, timeoutMs: 90_000, maxBytes: 1 << 20 });
  } catch (error) {
    // A resource that stops talking is this check failing, not an item-wide surprise.
    recorder.record(`${itemLabel}.content`, FAIL, {
      transport: "direct",
      reason: "the ranged read from the application did not finish",
      problem: error instanceof FixtureError ? error.code : "internal",
    });
    return;
  }
  // A provider range that cannot be read answers undefined, so the verdict below
  // becomes UNMEASURED instead of quietly passing.
  const theirs = mediaSourceId ? await client.original(itemId, mediaSourceId, range) : undefined;
  const verdict = classifyContentProbe({
    requestedRange: range,
    responseStatus: ranged.status,
    responseRange: ranged.headers.get("content-range"),
    responseBytes: ranged.bytes.length,
    providerStatus: theirs?.status,
    providerRange: theirs?.contentRange,
    providerBytes: theirs?.status === 206 ? theirs.bytes.length : undefined,
    providerHash: theirs?.status === 206 ? sha256Hex(theirs.bytes) : undefined,
    responseHash: sha256Hex(ranged.bytes),
  });
  recorder.record(`${itemLabel}.content`, verdict.status, {
    reason: verdict.reason,
    transport: "direct",
    status: ranged.status,
    length: Number.isFinite(length) ? length : null,
    rangeRequested: nonzero,
    contentRange: ranged.headers.get("content-range") ?? null,
    bytes: ranged.bytes.length,
    truncated: ranged.truncated === true,
    providerContentRange: theirs?.contentRange ?? null,
    providerStatus: theirs?.status ?? null,
    providerBytes: theirs?.bytes.length ?? null,
    hash: sha256Hex(ranged.bytes).slice(0, 16),
    providerVersions: versions.length,
  });
}

async function verifyHlsContent({ app, itemLabel, session, recorder }) {
  let playlist;
  try {
    playlist = await appCall(app, session.url, { timeoutMs: 60_000 });
  } catch (error) {
    recorder.record(`${itemLabel}.content`, FAIL, {
      transport: "hls",
      reason: "the playlist could not be read from the application",
      problem: error instanceof FixtureError ? error.code : "internal",
    });
    return;
  }
  const masterUrl = new URL(session.url, app.baseUrl);
  const { variant, init: initName, segment: segmentName } = playlistChildren(playlist.text, masterUrl);
  const deadline = Date.now() + 60_000;
  let mediaBytes = 0;
  let initBytes = 0;
  while (variant && Date.now() < deadline) {
    const variantCall = await appCall(app, variant, { timeoutMs: 30_000 });
    // A playlist's children are relative to the playlist that named them, exactly
    // as a player resolves them.
    const children = playlistChildren(variantCall.text, new URL(variant, app.baseUrl));
    if (children.segment !== undefined) {
      let initUsable = children.init === undefined;
      if (children.init !== undefined) {
        const init = await app.bytes(children.init, { timeoutMs: 30_000, maxBytes: SEGMENT_READ_MAX });
        initBytes += init.bytes.length;
        initUsable = init.status === 200 && init.bytes.length > 0;
      }
      const segment = await app.bytes(children.segment, { timeoutMs: 60_000, maxBytes: SEGMENT_READ_MAX });
      mediaBytes += segment.bytes.length;
      recorder.record(`${itemLabel}.content`, segment.status === 200 && segment.bytes.length > 0 && initUsable ? PASS : FAIL, {
        transport: "hls",
        playlistStatus: playlist.status,
        variantStatus: variantCall.status,
        segmentsFetched: 1,
        mediaBytes,
        initBytes,
        initDeclared: children.init !== undefined,
        initUsable,
        // The read is capped, so a very large segment is hashed only as far as it
        // was read; the flag says so rather than presenting a prefix as the whole.
        bytesHash: sha256Hex(segment.bytes).slice(0, 16),
        partialRead: segment.truncated === true,
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  recorder.record(`${itemLabel}.content`, FAIL, {
    transport: "hls",
    playlistStatus: playlist.status,
    variantFound: Boolean(variant),
    segmentsFetched: 0,
  });
}

async function verifySeek({ app, itemLabel, session, recorder }) {
  const duration = typeof session.duration === "number" && session.duration > 0 ? session.duration : undefined;
  if (duration !== undefined && duration <= 2) {
    recorder.skip(`${itemLabel}.seek-api`, "The fixture is too short for a nonzero seek before the server's end margin.");
    return session;
  }
  const target = duration ? Math.min(600, duration - 2, Math.max(0.1, Math.round(duration * 0.3))) : 30;
  const seek = await appCall(app, `/api/playback/${encodeURIComponent(session.id)}/seek`, {
    method: "POST",
    body: { time: target },
    timeoutMs: 120_000,
  });
  const offset = typeof seek.body?.offset === "number" ? seek.body.offset : undefined;
  const stable = seek.body?.id === session.id;
  const direct = (seek.body?.mode ?? session.mode) === "direct";
  const close = offset !== undefined && (direct ? offset === 0 : Math.abs(offset - target) <= 2);
  recorder.record(`${itemLabel}.seek-api`, seek.status === 200 && close && stable ? PASS : FAIL, {
    status: seek.status,
    requested: target,
    directRangeSeek: direct,
    browserTimestampMeasured: false,
    note: direct ? "Direct playback keeps API offset zero; the browser applies its own seek timestamp." : undefined,
    offset: offset === undefined ? null : Math.round(offset),
    duration: duration ?? null,
    sessionStable: stable,
  });
  return seek.status === 200 ? { ...session, ...seek.body } : session;
}

async function verifyTrack({ app, itemLabel, session, recorder }) {
  const tracks = Array.isArray(session?.audioTracks) ? session.audioTracks : [];
  if (tracks.length < 2) {
    recorder.skip(`${itemLabel}.track-change`, "only one audio track is available", { audioTracks: tracks.length });
    return;
  }
  const current = typeof session.audioTrack === "number" ? session.audioTrack : 0;
  const next = (current + 1) % tracks.length;
  const changed = await appCall(app, `/api/playback/${encodeURIComponent(session.id)}/track`, {
    method: "POST",
    body: { audio: next, time: typeof session.offset === "number" ? Math.round(session.offset) : 0 },
    timeoutMs: 120_000,
  });
  const stable = changed.body?.id === session.id;
  recorder.record(`${itemLabel}.track-change`, changed.status === 200 && changed.body?.audioTrack === next && stable ? PASS : FAIL, {
    status: changed.status,
    from: current,
    to: typeof changed.body?.audioTrack === "number" ? changed.body.audioTrack : null,
    sessionStable: stable,
  });
}

async function verifyExternalSubtitle({ app, itemLabel, streams, recorder }) {
  const withSubtitles = streams.find((stream) => Array.isArray(stream.subtitles) && stream.subtitles.length > 0);
  if (!withSubtitles) {
    recorder.skip(`${itemLabel}.external-subtitle`, "the provider offers no external text subtitle for this item");
    return;
  }
  const subtitle = withSubtitles.subtitles[0];
  const fetched = await app.bytes(`/api/subtitle/${encodeURIComponent(subtitle.subtitleId)}`, { timeoutMs: 60_000, maxBytes: 256 * 1024 });
  const text = fetched.bytes.toString("utf8");
  const textLike = /^\s*(WEBVTT|<\?\s*\d|\d+\s*$|\d{1,2}:\d{2}:\d{2})/m.test(text);
  recorder.record(`${itemLabel}.external-subtitle`, fetched.status === 200 && fetched.bytes.length > 0 && textLike ? PASS : FAIL, {
    status: fetched.status,
    bytes: fetched.bytes.length,
    textLike,
    languageTagged: typeof subtitle.lang === "string",
    tracksOffered: withSubtitles.subtitles.length,
  });
}

export async function verifySidecar({ app, session, itemLabel, recorder }) {
  if (typeof session?.sidecarUrl !== "string" && session.subtitleTracks?.length) {
    const selected = await appCall(app, `/api/playback/${encodeURIComponent(session.id)}/track`, {
      method: "POST", body: { subtitle: session.subtitleTracks[0].index, time: session.offset ?? 0 }, timeoutMs: 60_000,
    });
    if (selected.status !== 200) {
      recorder.fail(`${itemLabel}.embedded-subtitle`, { status: selected.status, reason: "The embedded subtitle could not be selected." });
      return;
    }
    session = { ...session, ...selected.body };
  }
  if (typeof session?.sidecarUrl !== "string") {
    recorder.skip(`${itemLabel}.embedded-subtitle`, "the item carries no embedded text track");
    return;
  }
  let fetched;
  const deadline = Date.now() + 6_000;
  do {
    fetched = await app.bytes(session.sidecarUrl, { timeoutMs: 10_000, maxBytes: 256 * 1024 });
    if (fetched.status !== 404 || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  recorder.record(`${itemLabel}.embedded-subtitle`, fetched.status === 200 && fetched.bytes.toString("utf8").includes("WEBVTT") ? PASS : FAIL, {
    status: fetched.status,
    bytes: fetched.bytes.length,
    complete: fetched.headers.get("x-sidecar-complete") === "1",
  });
}

/** Stores and reopens exact-version progress in the disposable application.
 * Browser-side automatic resume selection is outside this HTTP-only check. */
async function verifyResume({ app, itemLabel, session, chosen, versions, recorder }) {
  const remoteItem = chosen.remoteItem;
  const statePath = `/api/remote-libraries/${encodeURIComponent(remoteItem.libraryId)}/items/${encodeURIComponent(remoteItem.itemId)}/state`;
  const duration = typeof session.duration === "number" ? session.duration : undefined;
  const saved = clamp(Math.round((duration ?? 600) * 0.25), 5, 600);
  const other = versions.find((version) => version.id !== remoteItem.mediaSourceId);

  // The endpoint holds one version-tagged record per item, not a record per version.
  const untouched = await appCall(app, statePath);
  const untouchedPosition = typeof untouched.body?.position === "number" ? untouched.body.position : undefined;

  const written = await appCall(app, statePath, {
    method: "PATCH",
    body: { position: saved, duration: duration ?? saved * 4, mediaSourceId: remoteItem.mediaSourceId },
    timeoutMs: 60_000,
  });
  const read = await appCall(app, statePath);
  const readBack = typeof read.body?.position === "number" ? read.body.position : undefined;
  const tagsVersion = read.body?.mediaSourceId === remoteItem.mediaSourceId;
  recorder.unmeasured(`${itemLabel}.automatic-resume-version-isolation`, "Automatic resume selection belongs to the browser consumer, outside this HTTP-only profile.");
  const stored = written.status === 200 && read.status === 200 && untouched.status === 200
    && readBack !== undefined && Math.abs(readBack - saved) <= 1 && tagsVersion
    && (untouchedPosition === undefined || Math.abs(untouchedPosition - saved) > 1);
  recorder.record(`${itemLabel}.local-resume`, stored ? PASS : FAIL, {
    untouchedStatus: untouched.status,
    untouchedPosition: untouchedPosition === undefined ? null : Math.round(untouchedPosition),
    writeStatus: written.status,
    readStatus: read.status,
    readBack: readBack === undefined ? null : Math.round(readBack),
    stateTagsVersion: tagsVersion,
    saveApplied: saved,
  });

  await verifyResumeAcrossVersions({ app, itemLabel, statePath, session, chosen, other, saved, recorder });

  const reopened = await appCall(app, "/api/playback", {
    method: "POST",
    body: { sourceId: chosen.sourceId, capabilities: BROWSER_CAPABILITIES, time: saved },
    timeoutMs: 180_000,
  });
  if (typeof reopened.body?.id === "string") {
    await appCall(app, `/api/playback/${encodeURIComponent(reopened.body.id)}`, { method: "DELETE", timeoutMs: 30_000 });
  }
  const reopenOffset = typeof reopened.body?.offset === "number" ? reopened.body.offset : undefined;
  const reopenedAtSaved = reopened.status === 201 && reopenOffset !== undefined && Math.abs(reopenOffset - saved) <= 2;
  const directResume = reopened.status === 201 && reopened.body?.mode === "direct" && reopenOffset === 0;
  recorder.record(`${itemLabel}.local-resume-reopen`, directResume ? UNMEASURED : (reopenedAtSaved ? PASS : FAIL), {
    reason: directResume ? "The browser applies direct-play resume time; server offset correctly remains zero." : undefined,
    reopenStatus: reopened.status,
    reopenOffset: reopenOffset === undefined ? null : Math.round(reopenOffset),
    requested: saved,
  });
}

/** Replaces the item's progress version tag explicitly, then restores the first record. */
async function verifyResumeAcrossVersions({ app, itemLabel, statePath, session, chosen, other, saved, recorder }) {
  if (other === undefined) {
    recorder.skip(`${itemLabel}.local-resume-version-tag-write`, "the provider exposes a single playable version", { versions: 1 });
    return;
  }
  const duration = typeof session.duration === "number" ? session.duration : saved * 4;
  // Observe the current item record before replacing its version tag.
  const before = await appCall(app, statePath);
  const beforePosition = typeof before.body?.position === "number" ? before.body.position : undefined;
  const wrote = await appCall(app, statePath, {
    method: "PATCH",
    body: { position: 0, duration, mediaSourceId: other.id },
    timeoutMs: 60_000,
  });
  const after = await appCall(app, statePath);
  const afterPosition = typeof after.body?.position === "number" ? after.body.position : undefined;
  const tagsOther = after.body?.mediaSourceId === other.id;
  // Put the first version's position back, so the reopen below reads what it saved.
  const restored = await appCall(app, statePath, {
    method: "PATCH",
    body: { position: saved, duration, mediaSourceId: chosen.remoteItem.mediaSourceId },
    timeoutMs: 60_000,
  });
  const reread = await appCall(app, statePath);
  const restoredPosition = typeof reread.body?.position === "number" ? reread.body.position : undefined;
  const ok = before.status === 200 && wrote.status === 200 && after.status === 200
    && tagsOther && afterPosition === 0 && afterPosition !== saved
    && restored.status === 200 && reread.body?.mediaSourceId === chosen.remoteItem.mediaSourceId
    && restoredPosition !== undefined && Math.abs(restoredPosition - saved) <= 1;
  recorder.record(`${itemLabel}.local-resume-version-tag-write`, ok ? PASS : FAIL, {
    beforeStatus: before.status,
    beforePosition: beforePosition === undefined ? null : Math.round(beforePosition),
    writeStatus: wrote.status,
    readStatus: after.status,
    otherPosition: afterPosition === undefined ? null : Math.round(afterPosition),
    otherVersionTagged: tagsOther,
    note: "This checks explicit version-tag writes, not automatic browser resume selection.",
    restoreStatus: restored.status,
    restoredPosition: restoredPosition === undefined ? null : Math.round(restoredPosition),
  });
}

async function verifySecondVersion({ app, client, itemId, itemLabel, remote, versions, recorder }) {
  if (remote.length < 2) {
    recorder.skip(`${itemLabel}.second-version`, "the provider exposes a single playable version", { versions: remote.length });
    return;
  }
  const second = remote.slice(1).find((stream) => versions.some((version) => version.id === stream.remoteItem.mediaSourceId && version.videoCodec === "hevc")) ?? remote[1];
  const inspected = await appCall(app, "/api/inspect", { method: "POST", body: { sourceId: second.sourceId }, timeoutMs: 120_000 });
  const started = await appCall(app, "/api/playback", {
    method: "POST",
    body: { sourceId: second.sourceId, capabilities: BROWSER_CAPABILITIES, time: 0 },
    timeoutMs: 180_000,
  });
  let contentMeasured = false;
  if (started.status === 201 && typeof started.body?.id === "string" && typeof started.body?.url === "string") {
    try {
      // The second version gets the same nonzero-range comparison as the first:
      // two versions of one item are the case a "which file did we really play"
      // mistake hides in.
      await verifyContent({
        app,
        client,
        itemId,
        itemLabel: `${itemLabel}.second`,
        session: started.body,
        mediaSourceId: second.remoteItem.mediaSourceId,
        versions: [],
        recorder,
      });
      contentMeasured = true;
    } finally {
      await appCall(app, `/api/playback/${encodeURIComponent(started.body.id)}`, { method: "DELETE", timeoutMs: 30_000 });
    }
  }
  const separateSources = remote[0].sourceId !== second.sourceId;
  recorder.record(`${itemLabel}.second-version`, inspected.status === 200 && started.status === 201 && separateSources ? PASS : FAIL, {
    inspectStatus: inspected.status,
    startStatus: started.status,
    mode: typeof started.body?.mode === "string" ? started.body.mode : null,
    separateSources,
    contentMeasured,
    distinguishable: remote[0].name !== second.name
      || remote[0].behaviorHints?.videoSize !== second.behaviorHints?.videoSize
      || remote[0].behaviorHints?.filename !== second.behaviorHints?.filename,
  });
}

/** A finite provider fault, a restored observer, and the same source asked for
 *  again. A 429 must not start a storm of its own. */
async function verifyRecovery({ app, observer, itemLabel, sourceId, libraryId, recorder, delayMs }) {
  // A fault that was never served proves nothing: the application may have
  // answered from its own cache. Each scenario therefore reports the served-fault
  // count and the upstream attempts of the retry that follows, and a scenario
  // where the fault never reached the provider is NOT EXERCISED, never a pass.
  observer.armFault("versions", { kind: "status", status: 503, times: 1 });
  const served503 = observer.faultServed("versions", "status");
  const faulted = await appCall(app, "/api/inspect", { method: "POST", body: { sourceId }, timeoutMs: 120_000 });
  const served503Now = observer.faultServed("versions", "status") - served503;
  observer.clearFaults("versions");
  const dialsBeforeRetry = observer.dials("versions");
  const retried = await appCall(app, "/api/inspect", { method: "POST", body: { sourceId }, timeoutMs: 120_000 });
  const retryAttempts = observer.dials("versions") - dialsBeforeRetry;
  const recovered503 = retried.status === 200 && retryAttempts >= 1 && retryAttempts <= RECOVERY_ATTEMPT_MAX;
  recorder.record(`${itemLabel}.recovery-503`,
    served503Now === 0 ? SKIPPED : (recovered503 ? PASS : FAIL),
    served503Now === 0
      ? { reason: "the 503 was never served, so the application never asked the provider", faultedStatus: faulted.status, retriedStatus: retried.status }
      : { faultsServed: served503Now, faultedStatus: faulted.status, retryAttempts, retriedStatus: retried.status, attemptBudget: RECOVERY_ATTEMPT_MAX });

  observer.setLatency("original", Math.max(delayMs, 250));
  observer.armFault("original", { kind: "drop", times: 1 });
  const servedDrop = observer.faultServed("original", "drop");
  const dropped = await appCall(app, "/api/inspect", { method: "POST", body: { sourceId }, timeoutMs: 120_000 });
  const servedDropNow = observer.faultServed("original", "drop") - servedDrop;
  const dialsDuringDrop = observer.dials("original");
  observer.clearFaults("original");
  observer.setLatency("original", delayMs);
  const dialsBeforeRestore = observer.dials("original");
  const restored = await appCall(app, "/api/inspect", { method: "POST", body: { sourceId }, timeoutMs: 120_000 });
  const restoreAttempts = observer.dials("original") - dialsBeforeRestore;
  const recoveredDrop = restored.status === 200 && restoreAttempts >= 1 && restoreAttempts <= RECOVERY_ATTEMPT_MAX;
  recorder.record(`${itemLabel}.recovery-drop`,
    servedDropNow === 0 ? SKIPPED : (recoveredDrop ? PASS : FAIL),
    servedDropNow === 0
      ? { reason: "the dropped connection was never served, so the application never asked the provider", duringDropStatus: dropped.status }
      : { faultsServed: servedDropNow, duringDropStatus: dropped.status, attemptsWhileDropping: dialsDuringDrop, restoreAttempts, restoredStatus: restored.status, attemptBudget: RECOVERY_ATTEMPT_MAX });

  observer.armFault("listing", { kind: "status", status: 429, retryAfterSeconds: 1, times: 3 });
  const served429 = observer.faultServed("listing", "status");
  const before429 = observer.counters("listing").starts;
  const statuses = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    statuses.push((await appCall(app, `/api/remote-libraries/${encodeURIComponent(libraryId)}/browse?limit=${BROWSE_LIMIT}`)).status);
  }
  const requests429 = observer.counters("listing").starts - before429;
  const served429Now = observer.faultServed("listing", "status") - served429;
  observer.clearFaults("listing");
  const withinBudget = requests429 >= 1 && requests429 <= RATE_LIMIT_REQUEST_MAX;
  recorder.record(`${itemLabel}.rate-limit-budget`,
    served429Now === 0 ? SKIPPED : (withinBudget ? PASS : FAIL),
    served429Now === 0
      ? { reason: "the 429 was never served, so the application answered without asking the provider", statuses }
      : { faultsServed: served429Now, statuses, upstreamRequests: requests429, requestBudget: RATE_LIMIT_REQUEST_MAX });
}

/** Hold the original's first byte, start a request, give up on it, and see whether
 *  the application and the observer both let go. A hold that keeps upstream work
 *  alive after the client is gone is a real defect; a bound the platform cannot
 *  measure is reported as unmeasured rather than guessed at. */
async function verifyCancellation({ app, observer, itemLabel, sourceId, recorder, delayMs, inspectionWorked = true }) {
  const holdMs = Math.max(delayMs, CANCEL_DEFAULT_DELAY_MS);
  observer.setLatency("original", holdMs);
  const before = observer.counters("original");
  const dialsBefore = observer.dials("original");
  const childrenBefore = await appChildProcessCount(app.pid);
  const controller = new AbortController();
  const pending = app.request("/api/inspect", {
    method: "POST",
    body: { sourceId },
    signal: controller.signal,
    timeoutMs: 60_000,
  }).catch(() => undefined);
  // The hold only proves anything if the request really reached the original:
  // waiting for the observer to see it keeps a cached read from looking like a
  // pass, and a request that never arrives fails instead of being explained away.
  const arrived = await waitUntil(() => observer.counters("original").delayed > before.delayed, 5_000);
  const childrenDuring = await appChildProcessCount(app.pid);
  controller.abort(new FixtureError("client-abort", "the verification client gave up on the request"));
  await pending;
  await settleObserver(observer);
  const after = observer.counters("original");
  const dialsAfter = observer.dials("original");
  // The application's own probe is the work the abort has to stop: wait, bounded,
  // for nothing of it to be left rather than reading one sample and hoping.
  const childrenAfter = await waitForChildrenToSettle(app.pid, childrenBefore);
  observer.setLatency("original", delayMs);
  const dialsBeforeFollowing = observer.dials("original");
  const following = await appCall(app, "/api/inspect", { method: "POST", body: { sourceId }, timeoutMs: 120_000 });
  const abortedDelays = after.delayedAborted - before.delayedAborted;
  const lateStarts = Math.max(after.starts - before.starts - abortedDelays, 0);
  const upstreamClean = abortedDelays > 0 && dialsAfter === dialsBefore && observer.pending() === 0 && lateStarts === 0;
  const childrenClean = childrenAfter === null || childrenAfter <= (childrenBefore ?? 0);
  const followingWorks = following.status === 200 && observer.dials("original") >= dialsBeforeFollowing + 1;
  if (!arrived && !inspectionWorked) {
    // The probe could not read the source in the first place (no FFmpeg, say), so
    // nothing about cancellation was exercised here. It is not a pass, and it is
    // not this application failing to let go either.
    recorder.skip(`${itemLabel}.cancellation`, "inspection never read the source, so the held read could not be requested");
    recorder.skip(`${itemLabel}.cancellation-child-processes`, "the cancellation scenario did not run");
    return;
  }
  recorder.record(`${itemLabel}.cancellation`, arrived && upstreamClean && childrenClean && followingWorks ? PASS : FAIL, {
    holdMs,
    reachedOriginal: arrived,
    abortedDelays,
    upstreamDialsDuringHold: dialsAfter - dialsBefore,
    lateUpstreamStarts: lateStarts,
    pendingAfter: observer.pending(),
    childrenBefore,
    childrenDuring,
    childrenAfter,
    childrenSettled: childrenAfter === null ? null : childrenAfter <= (childrenBefore ?? 0),
    followingStatus: following.status,
    followingReachedOriginal: observer.dials("original") > dialsBeforeFollowing,
  });
  if (childrenBefore === null || childrenDuring === null || childrenAfter === null) {
    recorder.unmeasured(`${itemLabel}.cancellation-child-processes`, "`ps` is not available on this platform");
  } else {
    recorder.record(`${itemLabel}.cancellation-child-processes`, childrenAfter <= childrenBefore ? PASS : FAIL, {
      childrenBefore, childrenDuring, childrenAfter,
    });
  }
}

/** Wait, bounded, until `predicate` holds. */
const waitUntil = async (predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Wait, bounded, for the application to be back to at most `baseline` probe or
 *  converter processes. Answers the last count seen, or null when the platform
 *  cannot count them at all. */
async function waitForChildrenToSettle(pid, baseline, timeoutMs = 8_000) {
  if (baseline === null || baseline === undefined) return null;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const count = await appChildProcessCount(pid);
    if (count === null) return null;
    if (count <= baseline || Date.now() >= deadline) return count;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * The generated large-library profile: a real-protocol Jellyfin server behind the
 * same observer, browsed through the application's production routes. It asserts
 * structure, not speed.
 */
async function runSyntheticProfile({ app, config, recorder, observer, provider, slowProvider, slowObserver }) {
  const created = await appCall(app, "/api/media-servers", {
    method: "POST",
    body: {
      provider: provider.provider,
      name: "provider-1",
      baseUrl: observer.baseUrl,
      allowLan: false,
      allowLoopback: true,
      username: provider.username,
      password: provider.password,
    },
    timeoutMs: 60_000,
  });
  if (created.status !== 201 || typeof created.body?.id !== "string") {
    recorder.fail("synthetic.connection-create", { status: created.status });
    return;
  }
  recorder.pass("synthetic.connection-create", {
    status: created.status,
    catalogue: provider.catalogueTotal,
    folders: provider.folderTotal,
  });

  const discovered = await appCall(app, `/api/media-servers/${encodeURIComponent(created.body.id)}/libraries`, { timeoutMs: 60_000 });
  const libraries = Array.isArray(discovered.body?.items) ? discovered.body.items : [];
  if (libraries.length === 0) {
    recorder.fail("synthetic.library-discover", { status: discovered.status });
    return;
  }
  recorder.pass("synthetic.library-discover", {
    status: discovered.status,
    libraries: libraries.length,
    types: libraries.map((library) => library.type),
  });
  const attached = await appCall(app, `/api/media-servers/${encodeURIComponent(created.body.id)}/libraries`, {
    method: "POST",
    body: { remoteId: libraries[0].id },
    timeoutMs: 60_000,
  });
  if (attached.status !== 201 || typeof attached.body?.id !== "string") {
    recorder.fail("synthetic.library-attach", { status: attached.status });
    return;
  }
  app.remoteLibraryId = attached.body.id;
  recorder.pass("synthetic.library-attach", { status: attached.status });

  const memoryBefore = memoryMb((await appCall(app, "/api/diagnostics")).body);
  const fetchedBefore = provider.stats().itemsFetched;
  const titles = await traverseTitles({ app, observer, provider, libraryId: app.remoteLibraryId, config, recorder });
  const fetchedAfterTitles = provider.stats().itemsFetched;
  const folders = provider.folderTotal > 0
    ? await traverseFolders({ app, observer, provider, libraryId: app.remoteLibraryId, recorder })
    : (recorder.skip("synthetic.folder-mode", "the fixture generated a titles-only catalogue"), { rows: 0, status: SKIPPED });
  const fetchedAfterFolders = provider.stats().itemsFetched;
  const slowLibraryId = await attachSlowProvider({ app, recorder, slowObserver, provider: slowProvider });
  if (slowLibraryId === undefined) recorder.skip("synthetic.unrelated-provider", "the second provider could not be attached");
  else await verifyUnrelatedProvider({ app, config, recorder, slowObserver, slowLibraryId });

  const stats = provider.stats();
  const memoryAfter = memoryMb((await appCall(app, "/api/diagnostics")).body);
  // Every phase already proved it read exactly the rows it was handed. This bound
  // is the structural one the profile exists for: the provider may hand over at
  // most one page per browse request, never a walk of the catalogue behind one.
  const fetchedTotal = stats.itemsFetched - fetchedBefore;
  const browseRequests = observer.counters("listing").starts;
  const allowed = browseRequests * BROWSE_LIMIT + BROWSE_LIMIT;
  const withinBudget = fetchedTotal <= allowed;
  recorder.record("synthetic.fetch-budget", withinBudget ? PASS : FAIL, {
    itemsFetchedUpstream: fetchedTotal,
    browseRequests,
    allowed,
    titlesPhaseRows: titles.rows ?? null,
    traversalDelta: fetchedAfterTitles - fetchedBefore,
    folderRows: folders.rows ?? null,
    folderDelta: fetchedAfterFolders - fetchedAfterTitles,
    allowed,
    memoryBeforeMb: memoryBefore ?? null,
    memoryAfterMb: memoryAfter ?? null,
    growthMb: memoryBefore !== undefined && memoryAfter !== undefined ? memoryAfter - memoryBefore : null,
    catalogueTotal: provider.catalogueTotal,
    note: "an observation of this machine, not a portable performance guarantee",
  });
}

async function traverseTitles({ app, observer, provider, libraryId, config, recorder }) {
  await appCall(app, `/api/remote-libraries/${encodeURIComponent(libraryId)}`, { method: "PATCH", body: { browseMode: "titles" } });
  const pagePath = (cursor) => {
    const query = new URLSearchParams({ limit: String(BROWSE_LIMIT), mode: "titles" });
    if (cursor) query.set("cursor", cursor);
    return `/api/remote-libraries/${encodeURIComponent(libraryId)}/browse?${query}`;
  };
  const fetchedStart = provider.stats().itemsFetched;
  const seen = new Set();
  let cursor;
  let pages = 0;
  const upstreamPerPage = [];
  const pageSizes = [];
  const startedAt = Date.now();
  for (let pageIndex = 0; pageIndex < config.pages; pageIndex += 1) {
    const before = observer.counters("listing").starts;
    const page = await appCall(app, pagePath(cursor), { timeoutMs: 60_000 });
    upstreamPerPage.push(observer.counters("listing").starts - before);
    if (page.status !== 200 || !Array.isArray(page.body?.items)) {
      recorder.fail("synthetic.titles-traversal", { page: pageIndex + 1, status: page.status });
      return { rows: provider.stats().itemsFetched - fetchedStart, status: FAIL };
    }
    pages += 1;
    for (const item of page.body.items) if (typeof item?.id === "string") seen.add(item.id);
    pageSizes.push(page.body.items.length);
    cursor = typeof page.body.cursor === "string" ? page.body.cursor : undefined;
    if (!cursor) break;
  }
  const elapsedMs = Date.now() - startedAt;
  const stats = provider.stats();
  const expected = Math.min(config.pages * BROWSE_LIMIT, provider.catalogueTotal);
  const onePagePerRequest = upstreamPerPage.every((count) => count <= 1 + BROWSE_PAGE_SLACK);
  const noPerItemCalls = stats.details === 0 && stats.versions === 0 && stats.ancestors === 0;
  const boundedUpstreamLimits = stats.pageSizes.every((size) => size <= 200);
  const exactTraversal = seen.size === expected && pageSizes.reduce((total, value) => total + value, 0) === seen.size;
  // The provider counts the rows it actually handed over: it must be exactly what
  // the pages returned, which is what rules out a hidden recursive walk.
  const fetchedForPages = stats.itemsFetched - fetchedStart;
  const rowsMatchPages = fetchedForPages === seen.size;
  recorder.record("synthetic.titles-traversal",
    onePagePerRequest && noPerItemCalls && boundedUpstreamLimits && exactTraversal && rowsMatchPages ? PASS : FAIL, {
    pages,
    items: seen.size,
    expected,
    upstreamPerPage,
    upstreamPages: stats.pages,
    perItemDetailCalls: stats.details,
    perItemVersionCalls: stats.versions,
    ancestorCalls: stats.ancestors,
    maxUpstreamPageSize: stats.pageSizes.length ? Math.max(...stats.pageSizes) : 0,
    elapsedMs,
    itemsFetchedUpstream: fetchedForPages,
    rowsMatchPages,
  });

  const repeatBefore = observer.counters("listing").starts;
  const repeatFetchedStart = provider.stats().itemsFetched;
  const first = await appCall(app, pagePath(), { timeoutMs: 60_000 });
  const second = await appCall(app, pagePath(), { timeoutMs: 60_000 });
  const firstIds = Array.isArray(first.body?.items) ? first.body.items.map((item) => item?.id) : undefined;
  const secondIds = Array.isArray(second.body?.items) ? second.body.items.map((item) => item?.id) : undefined;
  // The same page, asked for twice, has to answer the same rows in the same order.
  // A cursor is this application's own envelope and its proof stamp moves, so the
  // requirement is that both answers agree on whether there is one, and that the
  // one which is offered really continues the listing.
  const sameOrder = firstIds !== undefined && secondIds !== undefined
    && firstIds.length === secondIds.length && firstIds.every((id, position) => id === secondIds[position]);
  const cursorParity = (first.body?.cursor === undefined) === (second.body?.cursor === undefined);
  let continued = true;
  let continuedStatus = null;
  let continuedIds = [];
  if (typeof second.body?.cursor === "string") {
    const query = new URLSearchParams({ limit: String(BROWSE_LIMIT), mode: "titles", cursor: second.body.cursor });
    const next = await appCall(app, `/api/remote-libraries/${encodeURIComponent(libraryId)}/browse?${query}`, { timeoutMs: 60_000 });
    continuedStatus = next.status;
    continuedIds = Array.isArray(next.body?.items) ? next.body.items.map((item) => item?.id) : [];
    continued = next.status === 200 && continuedIds.length > 0 && continuedIds.every((id) => !firstIds.includes(id));
  }
  const repeatFetched = provider.stats().itemsFetched - repeatFetchedStart;
  const repeatRowsExpected = (firstIds?.length ?? 0) + (secondIds?.length ?? 0) + continuedIds.length;
  recorder.record("synthetic.repeat-page",
    first.status === 200 && second.status === 200 && sameOrder && cursorParity && continued && repeatFetched === repeatRowsExpected ? PASS : FAIL, {
      firstStatus: first.status,
      secondStatus: second.status,
      sameOrderedItems: sameOrder,
      items: firstIds?.length ?? null,
      cursorParity,
      continuationStatus: continuedStatus,
      continuationHasNewItems: continued,
      upstreamRequestsForRepeat: observer.counters("listing").starts - repeatBefore,
      rowsFetchedForRepeat: repeatFetched,
      note: "the number of upstream requests a repeat makes is reported, not required",
    });

  observer.setLatency("listing", Math.max(config.delayMs, 1_500));
  const abortedBefore = observer.counters("listing").delayedAborted;
  const dialsBeforeCancel = observer.dials("listing");
  const controller = new AbortController();
  const pending = app.request(pagePath(), { signal: controller.signal, timeoutMs: 60_000 }).catch(() => undefined);
  const arrived = await waitUntil(() => observer.counters("listing").delayed > abortedBefore, 5_000);
  controller.abort(new FixtureError("client-abort", "the verification client gave up on the page"));
  await pending;
  const pendingAfter = await settleObserver(observer);
  const abortedAfter = observer.counters("listing").delayedAborted;
  const dialsAfterCancel = observer.dials("listing");
  observer.setLatency("listing", config.delayMs);
  const restoredFetchedStart = provider.stats().itemsFetched;
  const restored = await appCall(app, pagePath(), { timeoutMs: 60_000 });
  const restoredIds = Array.isArray(restored.body?.items) ? restored.body.items.map((item) => item?.id) : [];
  const restoredRowsMatch = provider.stats().itemsFetched - restoredFetchedStart === restoredIds.length;
  recorder.record("synthetic.cancel-delayed-page",
    arrived && abortedAfter > abortedBefore && dialsAfterCancel === dialsBeforeCancel && pendingAfter === 0
      && restored.status === 200 && restoredRowsMatch ? PASS : FAIL, {
    abortedDelays: abortedAfter - abortedBefore,
    reachedProvider: arrived,
    upstreamDialsForAbortedPage: dialsAfterCancel - dialsBeforeCancel,
    pendingAfter,
    restoredStatus: restored.status,
    restoredRowsMatch,
  });
  return { rows: provider.stats().itemsFetched - fetchedStart, status: PASS };
}

async function traverseFolders({ app, observer, provider, libraryId, recorder }) {
  await appCall(app, `/api/remote-libraries/${encodeURIComponent(libraryId)}`, { method: "PATCH", body: { browseMode: "folders" } });
  const before = observer.counters("listing").starts;
  const fetchedStart = provider.stats().itemsFetched;
  const root = await appCall(app, `/api/remote-libraries/${encodeURIComponent(libraryId)}/browse?limit=${BROWSE_LIMIT}&mode=folders`, { timeoutMs: 60_000 });
  const folders = Array.isArray(root.body?.items) ? root.body.items.filter((item) => item?.type === "folder") : [];
  if (root.status !== 200 || folders.length === 0) {
    recorder.record("synthetic.folder-mode", FAIL, { rootStatus: root.status, folders: folders.length });
  } else {
    const inside = await appCall(
      app,
      `/api/remote-libraries/${encodeURIComponent(libraryId)}/browse?limit=${BROWSE_LIMIT}&mode=folders&parentId=${encodeURIComponent(folders[0].id)}`,
      { timeoutMs: 60_000 },
    );
    const children = Array.isArray(inside.body?.items) ? inside.body.items : [];
    const stats = provider.stats();
    const rowsFetched = stats.itemsFetched - fetchedStart;
    const rowsMatchPages = rowsFetched === (Array.isArray(root.body?.items) ? root.body.items.length : 0) + children.length;
    recorder.record("synthetic.folder-mode",
      inside.status === 200 && children.length > 0 && stats.details === 0 && stats.versions === 0 && rowsMatchPages ? PASS : FAIL, {
      rootStatus: root.status,
      folders: folders.length,
      childStatus: inside.status,
      children: children.length,
      upstreamRequests: observer.counters("listing").starts - before,
      perItemDetailCalls: stats.details,
      perItemVersionCalls: stats.versions,
      rowsFetched,
      rowsMatchPages,
    });
  }
  await appCall(app, `/api/remote-libraries/${encodeURIComponent(libraryId)}`, { method: "PATCH", body: { browseMode: "titles" } });
  return { rows: provider.stats().itemsFetched - fetchedStart, status: PASS };
}

/** Connect and attach the second, unrelated provider; its library id is what the
 *  concurrency check browses while the first one is being held up. */
async function attachSlowProvider({ app, recorder, slowObserver, provider }) {
  const created = await appCall(app, "/api/media-servers", {
    method: "POST",
    body: {
      provider: provider.provider,
      name: "provider-2",
      baseUrl: slowObserver.baseUrl,
      allowLan: false,
      allowLoopback: true,
      username: provider.username,
      password: provider.password,
    },
    timeoutMs: 60_000,
  });
  if (created.status !== 201 || typeof created.body?.id !== "string") {
    recorder.fail("synthetic.second-connection", { status: created.status });
    return undefined;
  }
  const libraries = await appCall(app, `/api/media-servers/${encodeURIComponent(created.body.id)}/libraries`, { timeoutMs: 60_000 });
  const target = Array.isArray(libraries.body?.items) ? libraries.body.items[0] : undefined;
  if (target === undefined) {
    recorder.fail("synthetic.second-connection", { reason: "no library was discovered" });
    return undefined;
  }
  const attached = await appCall(app, `/api/media-servers/${encodeURIComponent(created.body.id)}/libraries`, {
    method: "POST",
    body: { remoteId: target.id },
    timeoutMs: 60_000,
  });
  if (attached.status !== 201 || typeof attached.body?.id !== "string") {
    recorder.fail("synthetic.second-connection", { reason: "the second library could not be attached", status: attached.status });
    return undefined;
  }
  recorder.pass("synthetic.second-connection", { status: created.status, libraries: 1 });
  return attached.body.id;
}

/** One slow provider must not hold up an unrelated one, and a provider that is
 *  simply gone must fail on its own without stopping the fast one. */
async function verifyUnrelatedProvider({ app, config, recorder, slowObserver, slowLibraryId }) {
  const slowMs = Math.max(config.delayMs, 1_200);
  slowObserver.setLatency("listing", slowMs);
  const slowPromise = appCall(app, `/api/remote-libraries/${encodeURIComponent(slowLibraryId)}/browse?limit=${BROWSE_LIMIT}&mode=titles`, { timeoutMs: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const fastStarted = Date.now();
  const fast = await appCall(app, `/api/remote-libraries/${encodeURIComponent(app.remoteLibraryId)}/browse?limit=${BROWSE_LIMIT}&mode=titles`, { timeoutMs: 60_000 });
  const fastMs = Date.now() - fastStarted;
  const slowInFlight = slowObserver.counters("listing").inFlight > 0;
  const slow = await slowPromise;
  slowObserver.setLatency("listing", 0);

  const deadPort = await freePort();
  const dead = await appCall(app, "/api/media-servers", {
    method: "POST",
    body: {
      provider: "jellyfin",
      name: "provider-offline",
      baseUrl: `http://127.0.0.1:${deadPort}`,
      allowLan: false,
      allowLoopback: true,
      username: "offline",
      password: "offline",
    },
    timeoutMs: 60_000,
  });
  let offlineStatus = null;
  if (dead.status === 201) {
    offlineStatus = (await appCall(app, `/api/media-servers/${encodeURIComponent(dead.body.id)}/libraries`, { timeoutMs: 60_000 })).status;
  }
  const healthyAfter = await appCall(app, `/api/remote-libraries/${encodeURIComponent(app.remoteLibraryId)}/browse?limit=${BROWSE_LIMIT}&mode=titles`, { timeoutMs: 60_000 });
  // A provider that is simply gone has to be answered with an error, not a hang,
  // and the healthy one has to keep working through it.
  const offlineAnswered = (dead.status >= 400 && dead.status < 600)
    || (dead.status === 201 && typeof offlineStatus === "number" && offlineStatus >= 400);
  const ok = fast.status === 200 && fastMs < slowMs && slowInFlight && slow.status === 200 && offlineAnswered && healthyAfter.status === 200;
  recorder.record("synthetic.unrelated-provider", ok ? PASS : FAIL, {
    fastMs,
    fastStatus: fast.status,
    slowMs,
    slowStatus: slow.status,
    slowInFlightDuringFast: slowInFlight,
    offlineConnectionStatus: dead.status,
    offlineLibraryStatus: offlineStatus,
    offlineAnsweredWithError: offlineAnswered,
    healthyAfterOffline: healthyAfter.status,
  });
}

const observedSummary = (observers) => observers.map((observer, index) => {
  const stats = observer.stats();
  return {
    label: `provider-${index + 1}`,
    categories: stats.app,
    refused: stats.refused,
    refusedTotal: Object.values(stats.refused).reduce((total, value) => total + value, 0),
    upstreamDials: stats.upstreamDials,
    fixtureReads: stats.fixture,
    faultsServed: stats.faultsServed,
    events: stats.events.slice(-MAX_REPORT_EVENTS),
  };
});

const reportShell = (config, observers, recorder, startedAt, application, observed) => ({
  version: REPORT_VERSION,
  generatedAt: new Date(startedAt).toISOString(),
  mode: config.mode,
  runner: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    durationMs: Date.now() - startedAt,
  },
  config: {
    items: config.items,
    pages: config.pages,
    delayMs: config.delayMs,
    providers: observers.length,
    browseLimit: BROWSE_LIMIT,
    capabilities: BROWSER_CAPABILITIES,
  },
  application,
  observed,
  checks: recorder.checks,
  skips: recorder.skips,
  unmeasured: recorder.unmeasuredChecks,
  caveats: recorder.caveats,
  contract: EXPORTED_CONTRACT,
  summary: {
    pass: recorder.checks.filter((check) => check.status === PASS).length,
    fail: recorder.failed.length,
    skipped: recorder.skips.length,
    unmeasured: recorder.unmeasuredChecks.length,
  },
  ok: recorder.failed.length === 0,
});

/**
 * The whole run. Every server it starts, it stops; the report it returns is the
 * only thing that leaves the process, and a structural failure is a failure of
 * the run, not a note in it.
 */
export async function runVerification(config, options = {}) {
  const repoRoot = options.repoRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const startedAt = Date.now();
  const recorder = new Recorder();
  const observers = [];
  const providers = [];
  let app;
  let observed = { providers: [] };
  if (config.mode === "fixture") {
    recorder.caveat("Fixture results describe the provider the operator supplied; the observed categories are the harness's reading of the wire, not a product metric.");
  } else {
    recorder.caveat("The synthetic catalogue is generated by the harness; it exercises the production browse routes against the documented Jellyfin protocol, not against a real server.");
  }
  recorder.caveat("This is HTTP-level evidence: no browser or TV decoder played anything, and no rendered frame was inspected.");
  recorder.caveat("Memory and elapsed observations describe this machine; browser DOM growth and viewport behaviour are a separate Playwright follow-up and are not claimed here.");
  try {
    app = await startDisposableApp({ repoRoot, port: await freePort(), logLevel: options.appLogLevel ?? "WARN" });
    if (config.mode === "synthetic") {
      const provider = await createSyntheticProvider({ items: config.items, folders: options.folders ?? 20 });
      providers.push(provider);
      observers.push(await createObservedProxy({ upstream: provider.baseUrl, label: "provider-1" }));
      const slowProvider = await createSyntheticProvider({ items: clamp(config.items, 60, 120), folders: 0 });
      providers.push(slowProvider);
      observers.push(await createObservedProxy({ upstream: slowProvider.baseUrl, label: "provider-2" }));
      await runSyntheticProfile({ app, config, recorder, observer: observers[0], provider, slowProvider, slowObserver: observers[1] });
    } else {
      if (!Array.isArray(options.fixture?.providers) || options.fixture.providers.length === 0) {
        recorder.fail("runner.fixture", { reason: "no provider was supplied" });
      } else {
        // Validated here as well, not only in the CLI: a caller that drives the
        // runner as a library gets the same refusal before a socket is opened.
        const checked = validateFixtureConfig(options.fixture);
        for (const [index, entry] of checked.providers.entries()) {
          observers.push(await createObservedProxy({ upstream: entry.baseUrl, label: `provider-${index + 1}` }));
        }
        await runFixtureProfile({ app, config, observers, recorder, fixture: checked });
      }
    }
    const diagnostics = await appCall(app, "/api/diagnostics");
    const reportsBuild = diagnostics.status === 200
      && typeof diagnostics.body?.version === "string"
      && typeof diagnostics.body?.node === "string";
    recorder.record("application.diagnostics", reportsBuild ? PASS : FAIL, {
      status: diagnostics.status,
      versionReported: typeof diagnostics.body?.version === "string",
      nodeReported: typeof diagnostics.body?.node === "string",
      sessions: playbackSessionIds(diagnostics.body).length,
      memoryMb: memoryMb(diagnostics.body) ?? null,
    });
    observed = { providers: observedSummary(observers) };
  } catch (error) {
    recorder.fail("runner.setup", { problem: error instanceof FixtureError ? error.code : "internal" });
    observed = { providers: observedSummary(observers) };
  } finally {
    for (const provider of providers) await provider.close().catch(() => undefined);
    for (const observer of observers) await observer.close().catch(() => undefined);
    if (app) await app.stop().catch(() => undefined);
  }
  const report = reportShell(config, observers, recorder, startedAt, {
    port: app?.port ?? null,
    version: app?.version ?? null,
    build: "disposable",
    strippedInheritedEnv: app?.strippedInheritedEnv ?? [],
  }, observed);
  // Everything the run produced is checked; the contract block is a static,
  // reviewed description of the exported signatures and names its parameters.
  assertReportSafe({ ...report, contract: undefined });
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  let config;
  try {
    config = parseRunnerArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "invalid arguments"}\n`);
    return 2;
  }
  if (config.mode === "help") {
    process.stdout.write(usageText());
    return 0;
  }
  let fixture;
  try {
    if (config.mode === "fixture") fixture = validateFixtureConfig(await readFile(config.fixturePath, "utf8"));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "the fixture could not be read"}\n`);
    return 2;
  }
  const report = await runVerification(config, { fixture });
  await writeFile(config.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${report.ok ? "ok" : "failed"}: ${config.outputPath} `
    + `(${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.skipped} skipped, ${report.summary.unmeasured} unmeasured)\n`,
  );
  return report.ok ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const code = await main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "the run failed"}\n`);
    return 1;
  });
  process.exitCode = code;
}
