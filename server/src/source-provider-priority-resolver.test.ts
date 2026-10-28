import assert from "node:assert/strict";
import test from "node:test";
import { addonIdentity } from "./addon-identity.js";
import type { DownloadJob, DownloadSelection } from "./downloads.js";
import { defaultDownloadSettings } from "./naming.js";
import type { MediaInfo } from "./probe.js";
import {
  materializeSourceAdmissionPolicy,
  parseSourceAdmissionSnapshotV1,
  type SourceAdmissionSnapshotV1,
} from "./source-admission.js";
import {
  createProviderPriorityProfileResolver,
  type ProviderPriorityProfileResolverInput,
} from "./source-profile-resolver.js";
import { PROVIDER_PRIORITY_INSPECTION_BUDGET } from "./source-provider-priority.js";
import {
  SOURCE_PROFILE_DEFINITIONS,
  SOURCE_PROFILE_IDS,
} from "./source-profiles.js";
import type { SourceResolverDeps } from "./source-resolver.js";
import type { AddonDownloadSettings, AddonRecord, StreamItem, SubtitleItem } from "./types.js";
import type { UserRecord } from "./users.js";

const OWNER = "usr_00000011";
const providerPriorityDefinition = SOURCE_PROFILE_DEFINITIONS.find((definition) =>
  definition.id === SOURCE_PROFILE_IDS.providerPriority);
const travelDefinition = SOURCE_PROFILE_DEFINITIONS.find((definition) =>
  definition.id === SOURCE_PROFILE_IDS.travel);
assert.ok(providerPriorityDefinition);
assert.ok(travelDefinition);

const snapshot = (
  providerKeys: string[] = ["addon:one"],
): SourceAdmissionSnapshotV1 => {
  const source = structuredClone(providerPriorityDefinition.policy);
  source.constraints.subtitles = { mode: "optional", preferred: { code: "en" } };
  return parseSourceAdmissionSnapshotV1({
    schemaVersion: 1,
    profile: { id: SOURCE_PROFILE_IDS.providerPriority, revision: 1 },
    operation: "downloadToLibrary",
    providerKeys,
    policy: materializeSourceAdmissionPolicy(source, providerKeys, {
      audioLanguage: "en",
      subtitleLanguage: "en",
    }),
  });
};

const travelSnapshot = (): SourceAdmissionSnapshotV1 => parseSourceAdmissionSnapshotV1({
  schemaVersion: 1,
  profile: { id: SOURCE_PROFILE_IDS.travel, revision: 1 },
  operation: "downloadToLibrary",
  providerKeys: ["addon:one"],
  policy: materializeSourceAdmissionPolicy(
    travelDefinition.policy,
    ["addon:one"],
    { audioLanguage: "en", subtitleLanguage: "en" },
  ),
});

const user = (overrides: Partial<UserRecord> = {}): UserRecord => ({
  id: OWNER,
  username: "owner",
  passwordHash: "scrypt$aa$bb",
  secret: "secret",
  role: "user",
  createdAt: "2026-01-01T00:00:00.000Z",
  permissions: { downloadToLibrary: true, downloadToDevice: true },
  permissionsVersion: 0,
  ...overrides,
});

const addon = (
  key: string,
  options: {
    readonly allowedUsers?: string[];
    readonly role?: AddonRecord["role"];
    readonly resources?: AddonRecord["manifest"]["resources"];
    readonly version?: string;
    readonly enabled?: boolean;
    readonly name?: string;
    readonly settings?: AddonDownloadSettings;
  } = {},
): AddonRecord => ({
  key,
  manifestUrl: `https://${key}.example/manifest.json`,
  role: options.role ?? "source",
  enabled: options.enabled ?? true,
  globalSearch: true,
  allowedUsers: options.allowedUsers ?? [OWNER],
  addedAt: "2026-01-01T00:00:00.000Z",
  downloadSettings: options.settings ?? defaultDownloadSettings(),
  manifest: {
    id: key,
    name: options.name ?? key,
    version: options.version ?? "1",
    resources: options.resources ?? ["stream"],
  },
});

const subtitleAddon = (key = "subs"): AddonRecord =>
  addon(key, {
    role: "both",
    resources: [{ name: "subtitles", types: ["movie", "series"] }],
  });

const selection = (
  overrides: Partial<DownloadSelection> = {},
): DownloadSelection => ({
  addonKeys: ["one"],
  sourceStrategy: "priority",
  audioLanguage: "en",
  subtitleMode: "off",
  targetSettings: { subfolder: "", layout: "structured" },
  ...overrides,
});

const source = (
  overrides: Partial<NonNullable<DownloadJob["source"]>> = {},
): NonNullable<DownloadJob["source"]> => ({
  type: "series",
  videoId: "tt123:1:1",
  tried: [],
  selection: selection(),
  ...overrides,
});

const stream = (
  addonKey: string,
  url: string,
  size = 10,
  overrides: Partial<StreamItem> = {},
): StreamItem => ({
  addonKey,
  url,
  name: "English release",
  title: "Episode",
  behaviorHints: { videoSize: size },
  ...overrides,
});

const media = (audio: readonly string[] = ["en"]): MediaInfo => ({
  container: "matroska",
  duration: 3_600,
  video: { codec: "h264", height: 1_080 },
  audioTracks: audio.map((language, index) => ({
    index,
    codec: "aac",
    language,
  })),
  subtitleTracks: [],
});

const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

interface State {
  users: UserRecord[];
  addons: AddonRecord[];
}

interface FakeDependencies {
  readonly hasRealDebrid?: () => boolean;
  readonly listStreams?: SourceResolverDeps["listStreams"];
  readonly listSubtitles?: SourceResolverDeps["listSubtitles"];
  readonly inspect?: SourceResolverDeps["inspect"];
  readonly serverReady?: Promise<void>;
}

const resolverFor = (state: State, fake: FakeDependencies = {}) => {
  const deps: SourceResolverDeps = {
    users: () => state.users,
    addons: () => state.addons,
    prefs: () => ({ audioLanguage: "en" }),
    hasRealDebrid: fake.hasRealDebrid ?? (() => true),
    serverReady: fake.serverReady ?? Promise.resolve(),
    listStreams: fake.listStreams ?? (async () => []),
    listSubtitles: fake.listSubtitles ?? (async () => []),
    inspect: fake.inspect ?? (async () => media()),
    remoteDownloadCandidates: async () => [],
  };
  return createProviderPriorityProfileResolver(deps);
};

const input = (
  snapshotValue: SourceAdmissionSnapshotV1,
  signal: AbortSignal,
  overrides: Partial<ProviderPriorityProfileResolverInput> = {},
): ProviderPriorityProfileResolverInput => ({
  source: source(),
  snapshot: snapshotValue,
  ownerUserId: OWNER,
  signal,
  ...overrides,
});

test("lists only scoped provider keys and returns current settings with the selected hash", async () => {
  const selectedSettings: AddonDownloadSettings = {
    movie: { subfolder: "Movies", layout: "flat" },
    series: { subfolder: "Shows", layout: "structured", libraryId: "lib_beta" },
  };
  const beta = addon("beta", { name: "Shared provider", settings: selectedSettings });
  const alpha = addon("alpha", { name: "Shared provider" });
  const outside = addon("outside");
  const revoked = addon("revoked", { allowedUsers: [] });
  const state = { users: [user()], addons: [alpha, beta, outside, revoked] };
  const requested: string[][] = [];
  const resolver = resolverFor(state, {
    listStreams: async (addons) => {
      requested.push(addons.map((item) => item.key));
      return [
        stream("alpha", "https://media.example/alpha.mkv", 100),
        stream("beta", "https://media.example/beta.mkv", 1),
        stream("outside", "https://media.example/outside.mkv"),
        stream("revoked", "https://media.example/revoked.mkv"),
      ];
    },
  });

  const result = await resolver(input(snapshot(["addon:beta", "addon:alpha"]),
    new AbortController().signal));

  assert.equal(result.status, "selected");
  if (result.status !== "selected") return;
  assert.equal(result.stream.addonKey, "beta");
  assert.deepEqual(result.settings, selectedSettings);
  assert.equal(result.streamAddonIdentity, addonIdentity(beta));
  assert.deepEqual(requested, [["alpha", "beta"]]);
  assert.equal("candidate" in result, false);
  assert.equal("info" in result, false);
});

test("subtitle listing waits for server readiness", async () => {
  const ready = deferred();
  const state = {
    users: [user()],
    addons: [addon("one"), subtitleAddon()],
  };
  let subtitleLookups = 0;
  const resolver = resolverFor(state, {
    serverReady: ready.promise,
    listStreams: async () => [stream("one", "https://media.example/one.mkv")],
    listSubtitles: async () => {
      subtitleLookups += 1;
      return [{ addonKey: "subs", url: "https://subs.example/en.srt", lang: "en" }];
    },
  });

  const resolving = resolver(input(snapshot(["addon:one"]), new AbortController().signal));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subtitleLookups, 0);
  ready.release();

  const result = await resolving;
  assert.equal(result.status, "selected");
  assert.equal(subtitleLookups, 1);
});

test("an owner or provider permission loss during deferred listing denies access before other provider work", async () => {
  for (const change of ["owner", "grant", "identity", "role", "resource", "enabled"] as const) {
    await test(`during listing: ${change}`, async () => {
      const gate = deferred();
      const state = { users: [user()], addons: [addon("one"), subtitleAddon()] };
      let subtitleLookups = 0;
      let probes = 0;
      const resolver = resolverFor(state, {
        listStreams: async () => {
          await gate.promise;
          return [stream("one", "https://media.example/one.mkv")];
        },
        listSubtitles: async () => {
          subtitleLookups += 1;
          return [];
        },
        inspect: async () => {
          probes += 1;
          return media();
        },
      });

      const resolving = resolver(input(snapshot(["addon:one"]), new AbortController().signal));
      if (change === "owner") state.users[0] = user({ disabled: true });
      else if (change === "grant") state.addons[0] = { ...state.addons[0]!, allowedUsers: [] };
      else if (change === "identity") {
        state.addons[0] = {
          ...state.addons[0]!,
          manifest: { ...state.addons[0]!.manifest, version: "2" },
        };
      } else if (change === "role") state.addons[0] = { ...state.addons[0]!, role: "catalog" };
      else if (change === "resource") {
        state.addons[0] = {
          ...state.addons[0]!,
          manifest: { ...state.addons[0]!.manifest, resources: [] },
        };
      } else state.addons[0] = { ...state.addons[0]!, enabled: false };
      gate.release();

      const result = await resolving;
      assert.equal(result.status, "accessDenied");
      assert.equal(subtitleLookups, 0);
      assert.equal(probes, 0);
    });
  }
});

test("provider permission, identity, role or resource loss during inspection denies the stale winner", async () => {
  for (const change of ["grant", "identity", "role", "resource", "enabled"] as const) {
    await test(`during inspection: ${change}`, async () => {
      const state = { users: [user()], addons: [addon("one")] };
      let probes = 0;
      const resolver = resolverFor(state, {
        listStreams: async () => [stream("one", "https://media.example/one.mkv")],
        inspect: async () => {
          probes += 1;
          if (change === "grant") state.addons[0] = { ...state.addons[0]!, allowedUsers: [] };
          else if (change === "identity") {
            state.addons[0] = {
              ...state.addons[0]!,
              manifest: { ...state.addons[0]!.manifest, version: "2" },
            };
          } else if (change === "role") state.addons[0] = { ...state.addons[0]!, role: "catalog" };
          else if (change === "resource") {
            state.addons[0] = {
              ...state.addons[0]!,
              manifest: { ...state.addons[0]!.manifest, resources: [] },
            };
          } else state.addons[0] = { ...state.addons[0]!, enabled: false };
          return media();
        },
      });

      const result = await resolver(input(snapshot(), new AbortController().signal));

      assert.equal(result.status, "accessDenied");
      assert.equal(probes, 1);
      assert.equal("stream" in result, false);
    });
  }
});

test("selected subtitle identity loss during inspection denies the result", async () => {
  const state = { users: [user()], addons: [addon("one"), subtitleAddon()] };
  const resolver = resolverFor(state, {
    listStreams: async () => [stream("one", "https://media.example/one.mkv")],
    listSubtitles: async () => [
      { addonKey: "subs", url: "https://subs.example/episode.en.srt", lang: "en" },
    ],
    inspect: async () => {
      state.addons[1] = { ...state.addons[1]!, allowedUsers: [] };
      return media();
    },
  });

  const result = await resolver(input(snapshot(["addon:one"]), new AbortController().signal));

  assert.equal(result.status, "accessDenied");
  assert.equal("stream" in result, false);
  assert.equal("subtitle" in result, false);
});

test("abort during provider listing cancels without subtitle or inspection calls", async () => {
  const gate = deferred();
  const controller = new AbortController();
  const state = { users: [user()], addons: [addon("one"), subtitleAddon()] };
  let subtitleLookups = 0;
  let probes = 0;
  const resolver = resolverFor(state, {
    listStreams: async () => {
      await gate.promise;
      return [stream("one", "https://media.example/one.mkv")];
    },
    listSubtitles: async () => {
      subtitleLookups += 1;
      return [];
    },
    inspect: async () => {
      probes += 1;
      return media();
    },
  });

  const resolving = resolver(input(snapshot(["addon:one"]), controller.signal));
  controller.abort();
  gate.release();

  const result = await resolving;
  assert.equal(result.status, "cancelled");
  assert.equal(subtitleLookups, 0);
  assert.equal(probes, 0);
});

test("HTTP selection returns probe-backed audio resolution", async () => {
  const provider = addon("one");
  const state = { users: [user()], addons: [provider] };
  const resolver = resolverFor(state, {
    listStreams: async () => [stream("one", "https://media.example/episode.mkv")],
    inspect: async () => media(["cs"]),
  });

  const result = await resolver(input(snapshot(), new AbortController().signal));

  assert.equal(result.status, "selected");
  if (result.status !== "selected") return;
  assert.equal(result.resolution.checkedCandidates, 1);
  assert.equal(result.resolution.audioLanguage, "cs");
  assert.equal(result.resolution.audioTrack, 0);
  assert.equal(result.resolution.audioEvidence, "probe");
  assert.equal(result.searchStatus, "complete");
  assert.equal(result.streamAddonIdentity, addonIdentity(provider));
});

test("torrent selection uses listing-only evidence, subtitle proof and checks Real-Debrid again", async () => {
  const provider = addon("one");
  const subs = subtitleAddon();
  const state = { users: [user()], addons: [provider, subs] };
  const realDebrid = [true, true];
  let probes = 0;
  const resolver = resolverFor(state, {
    hasRealDebrid: () => realDebrid.shift() ?? false,
    listStreams: async () => [{
      addonKey: "one",
      infoHash: "a".repeat(40),
      fileIdx: 0,
      name: "English release",
    }],
    listSubtitles: async () => [
      { addonKey: "subs", url: "https://subs.example/episode.en.srt", lang: "en" },
    ],
    inspect: async () => {
      probes += 1;
      return media();
    },
  });

  const result = await resolver(input(snapshot(["addon:one"]), new AbortController().signal));

  assert.equal(result.status, "selected");
  if (result.status !== "selected") return;
  assert.equal(probes, 0);
  assert.equal(result.resolution.audioLanguage, "en");
  assert.equal(result.resolution.audioEvidence, "listing");
  assert.equal("audioTrack" in result.resolution, false);
  assert.equal(result.subtitle?.addonKey, "subs");
  assert.equal(result.subtitleAddonIdentity, addonIdentity(subs));
  assert.deepEqual(realDebrid, []);
});

test("Real-Debrid loss before returning a torrent denies the selection", async () => {
  const state = { users: [user()], addons: [addon("one")] };
  const realDebrid = [true, false];
  const resolver = resolverFor(state, {
    hasRealDebrid: () => realDebrid.shift() ?? false,
    listStreams: async () => [{
      addonKey: "one",
      infoHash: "a".repeat(40),
      fileIdx: 0,
      name: "English release",
    }],
  });

  const result = await resolver(input(snapshot(), new AbortController().signal));

  assert.equal(result.status, "accessDenied");
  assert.equal("stream" in result, false);
});

test("invalid Provider priority input throws before provider calls", async () => {
  const state = { users: [user()], addons: [addon("one")] };
  let requests = 0;
  const resolver = resolverFor(state, {
    listStreams: async () => {
      requests += 1;
      return [];
    },
  });

  for (const invalid of [
    travelSnapshot(),
    {
      ...snapshot(),
      profile: { id: SOURCE_PROFILE_IDS.providerPriority, revision: 2 },
    } as SourceAdmissionSnapshotV1,
    { ...snapshot(), operation: "play" } as SourceAdmissionSnapshotV1,
  ]) {
    await assert.rejects(
      resolver(input(invalid, new AbortController().signal)),
      (error: unknown) => error instanceof Error
        && error.name === "ProviderPrioritySnapshotError",
    );
  }
  assert.equal(requests, 0);
});

test("a selected result reports incomplete search when the HTTP probe cap truncates candidates", async () => {
  const state = { users: [user()], addons: [addon("one")] };
  const streams = Array.from(
    { length: PROVIDER_PRIORITY_INSPECTION_BUDGET + 1 },
    (_entry, index) => stream(
      "one",
      `https://media.example/candidate-${index}.mkv`,
      PROVIDER_PRIORITY_INSPECTION_BUDGET + 1 - index,
    ),
  );
  let probes = 0;
  const resolver = resolverFor(state, {
    listStreams: async () => streams,
    inspect: async () => {
      probes += 1;
      return media();
    },
  });

  const result = await resolver(input(snapshot(), new AbortController().signal));

  assert.equal(result.status, "selected");
  if (result.status !== "selected") return;
  assert.equal(result.searchStatus, "incompleteSearch");
  assert.equal(probes, PROVIDER_PRIORITY_INSPECTION_BUDGET);
});
