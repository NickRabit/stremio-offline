import assert from "node:assert/strict";
import test from "node:test";
import { addonIdentity } from "./addon-identity.js";
import type { DownloadJob, DownloadSelection } from "./downloads.js";
import { defaultDownloadSettings } from "./naming.js";
import type { MediaInfo } from "./probe.js";
import {
  materializeSourceAdmissionPolicy,
  type SourceAdmissionSnapshotV1,
} from "./source-admission.js";
import {
  createTravelProfileResolver,
  type TravelProfileResolverInput,
} from "./source-profile-resolver.js";
import { parseSourcePolicyV1 } from "./source-policy.js";
import { SOURCE_PROFILE_DEFINITIONS, SOURCE_PROFILE_IDS } from "./source-profiles.js";
import type { SourceResolverDeps } from "./source-resolver.js";
import { TRAVEL_INSPECTION_BUDGET } from "./source-travel.js";
import type { AddonDownloadSettings, AddonRecord, StreamItem } from "./types.js";
import type { UserRecord } from "./users.js";

const OWNER = "usr_00000011";
const travelDefinition = SOURCE_PROFILE_DEFINITIONS.find((definition) =>
  definition.id === SOURCE_PROFILE_IDS.travel);
assert.ok(travelDefinition);

interface SnapshotOptions {
  readonly subtitleMode?: "off" | "optional" | "required";
}

const snapshot = (
  providerKeys: string[] = ["addon:one"],
  options: SnapshotOptions = {},
): SourceAdmissionSnapshotV1 => {
  const source = structuredClone(travelDefinition.policy);
  source.constraints.audio = {
    mode: "preferred",
    preferred: { code: "en" },
  };
  const subtitleMode = options.subtitleMode ?? "off";
  source.constraints.subtitles = subtitleMode === "off"
    ? { mode: "off" }
    : { mode: subtitleMode, preferred: { code: "en" } };
  const policy = parseSourcePolicyV1(source);
  return {
    schemaVersion: 1,
    profile: { id: SOURCE_PROFILE_IDS.travel, revision: 1, template: "travel" },
    operation: "downloadToLibrary",
    providerKeys,
    policy: materializeSourceAdmissionPolicy(policy, providerKeys, {}),
  };
};

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
    readonly settings?: AddonDownloadSettings;
  } = {},
): AddonRecord => ({
  key,
  manifestUrl: `https://${key}.example/manifest.json`,
  role: options.role ?? "source",
  enabled: true,
  globalSearch: true,
  allowedUsers: options.allowedUsers ?? [OWNER],
  addedAt: "2026-01-01T00:00:00.000Z",
  downloadSettings: options.settings ?? defaultDownloadSettings(),
  manifest: {
    id: key,
    name: key,
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

const media = (height = 480): MediaInfo => ({
  container: "matroska",
  duration: 3_600,
  video: { codec: "h264", height },
  audioTracks: [{ index: 0, codec: "aac", language: "en" }],
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
    hasRealDebrid: () => true,
    serverReady: fake.serverReady ?? Promise.resolve(),
    listStreams: fake.listStreams ?? (async () => []),
    listSubtitles: fake.listSubtitles ?? (async () => []),
    inspect: fake.inspect ?? (async () => media()),
  };
  return createTravelProfileResolver(deps);
};

const input = (
  snapshotValue: SourceAdmissionSnapshotV1,
  signal: AbortSignal,
  overrides: Partial<TravelProfileResolverInput> = {},
): TravelProfileResolverInput => ({
  source: source(),
  snapshot: snapshotValue,
  ownerUserId: OWNER,
  signal,
  ...overrides,
});

test("asks only scoped providers and returns the selected addon settings", async () => {
  const selectedSettings: AddonDownloadSettings = {
    movie: { subfolder: "Movies", layout: "flat" },
    series: { subfolder: "Shows", layout: "structured", libraryId: "lib_selected" },
  };
  const scoped = addon("one", { settings: selectedSettings });
  const broaderGrant = addon("outside-snapshot");
  const revoked = addon("revoked", { allowedUsers: [] });
  const state = { users: [user()], addons: [scoped, broaderGrant, revoked] };
  const requested: string[][] = [];
  const probed: string[] = [];
  const resolver = resolverFor(state, {
    listStreams: async (addons) => {
      requested.push(addons.map((item) => item.key));
      return [
        stream("one", "https://media.example/scoped.mkv"),
        stream("outside-snapshot", "https://media.example/outside.mkv"),
        stream("revoked", "https://media.example/revoked.mkv"),
      ];
    },
    inspect: async (item) => {
      probed.push(item.addonKey!);
      return media();
    },
  });

  const result = await resolver(input(snapshot(), new AbortController().signal));

  assert.equal(result.status, "selected");
  if (result.status !== "selected") return;
  assert.equal(result.stream.addonKey, "one");
  assert.deepEqual(result.settings, selectedSettings);
  assert.equal(result.streamAddonIdentity, addonIdentity(scoped));
  assert.deepEqual(requested, [["one"]]);
  assert.deepEqual(probed, ["one"]);
});

test("selected stream and subtitle identities are hashes captured at the final check", async () => {
  const streamAddon = addon("one");
  const subs = subtitleAddon();
  const state = { users: [user()], addons: [streamAddon, subs] };
  const resolver = resolverFor(state, {
    listStreams: async () => [stream("one", "https://media.example/episode.mkv?token=stream-secret")],
    listSubtitles: async () => [{
      addonKey: "subs",
      url: "https://subs.example/episode.srt?token=subtitle-secret",
      lang: "en",
    }],
    inspect: async () => media(),
  });

  const result = await resolver(input(snapshot(["addon:one"], { subtitleMode: "required" }),
    new AbortController().signal));

  assert.equal(result.status, "selected");
  if (result.status !== "selected") return;
  assert.equal(result.streamAddonIdentity, addonIdentity(streamAddon));
  assert.equal(result.subtitleAddonIdentity, addonIdentity(subs));
  assert.match(result.streamAddonIdentity, /^[0-9a-f]{64}$/);
  assert.match(result.subtitleAddonIdentity, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify({
    streamAddonIdentity: result.streamAddonIdentity,
    subtitleAddonIdentity: result.subtitleAddonIdentity,
  }), /manifest\.json|stream-secret|subtitle-secret/);
});

test("a stream grant or addon identity that changes during listing denies access before probing", async () => {
  for (const change of ["grant", "identity"] as const) {
    await test(`during listing: ${change}`, async () => {
      const gate = deferred();
      const state = { users: [user()], addons: [addon("one")] };
      let probes = 0;
      let subtitleLookups = 0;
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

      const resolving = resolver(input(snapshot(), new AbortController().signal));
      state.addons[0] = change === "grant"
        ? { ...state.addons[0]!, allowedUsers: [] }
        : { ...state.addons[0]!, manifest: { ...state.addons[0]!.manifest, version: "2" } };
      gate.release();
      const result = await resolving;

      assert.equal(result.status, "accessDenied");
      assert.equal(probes, 0);
      assert.equal(subtitleLookups, 0);
    });
  }
});

test("a disabled, deleted, or ungranted owner is denied without requests", async () => {
  for (const owner of [
    user({ disabled: true }),
    user({ permissions: { downloadToLibrary: false, downloadToDevice: true } }),
  ]) {
    const state = { users: [owner], addons: [addon("one")] };
    let requests = 0;
    const resolver = resolverFor(state, {
      listStreams: async () => {
        requests += 1;
        return [];
      },
    });
    const result = await resolver(input(snapshot(), new AbortController().signal));
    assert.equal(result.status, "accessDenied");
    assert.equal(requests, 0);
  }

  const state = { users: [] as UserRecord[], addons: [addon("one")] };
  const resolver = resolverFor(state);
  const result = await resolver(input(snapshot(), new AbortController().signal));
  assert.equal(result.status, "accessDenied");
});

test("no currently allowed provider in the snapshot is denied without listing", async () => {
  const state = {
    users: [user()],
    addons: [addon("outside-snapshot"), addon("one", { allowedUsers: [] })],
  };
  let requests = 0;
  const resolver = resolverFor(state, {
    listStreams: async () => {
      requests += 1;
      return [];
    },
  });

  const result = await resolver(input(snapshot(), new AbortController().signal));

  assert.equal(result.status, "accessDenied");
  assert.equal(requests, 0);
});

test("a subtitle grant revoked during listing removes its rows but does not invent a fallback", async () => {
  const gate = deferred();
  const streamAddon = addon("one");
  const subs = subtitleAddon();
  const state = { users: [user()], addons: [streamAddon, subs] };
  const resolver = resolverFor(state, {
    listStreams: async () => [stream("one", "https://media.example/one.mkv")],
    listSubtitles: async () => {
      await gate.promise;
      return [{ addonKey: "subs", url: "https://subs.example/episode.srt", lang: "en" }];
    },
    inspect: async () => media(),
  });

  const resolving = resolver(input(snapshot(["addon:one"], { subtitleMode: "optional" }),
    new AbortController().signal));
  state.addons[1] = { ...state.addons[1]!, allowedUsers: [] };
  gate.release();
  const result = await resolving;

  assert.equal(result.status, "selected");
  if (result.status !== "selected") return;
  assert.equal(result.subtitle, undefined);
  assert.equal(result.resolution.subtitleStatus, "missing");
});

test("a stream identity rotated during subtitle listing denies access before probing", async () => {
  const gate = deferred();
  const state = { users: [user()], addons: [addon("one"), subtitleAddon()] };
  let probes = 0;
  const resolver = resolverFor(state, {
    listStreams: async () => [stream("one", "https://media.example/one.mkv")],
    listSubtitles: async () => {
      await gate.promise;
      return [];
    },
    inspect: async () => {
      probes += 1;
      return media();
    },
  });

  const resolving = resolver(input(snapshot(["addon:one"], { subtitleMode: "optional" }),
    new AbortController().signal));
  state.addons[0] = {
    ...state.addons[0]!,
    manifest: { ...state.addons[0]!.manifest, version: "2" },
  };
  gate.release();
  const result = await resolving;

  assert.equal(result.status, "accessDenied");
  assert.equal(probes, 0);
});

test("stream revocation during a probe never returns a selected stream", async () => {
  for (const change of ["grant", "identity"] as const) {
    await test(`during probe: ${change}`, async () => {
      const gate = deferred();
      const state = { users: [user()], addons: [addon("one")] };
      let probes = 0;
      const resolver = resolverFor(state, {
        listStreams: async () => [stream("one", "https://media.example/one.mkv")],
        inspect: async () => {
          probes += 1;
          await gate.promise;
          return media();
        },
      });

      const resolving = resolver(input(snapshot(), new AbortController().signal));
      await new Promise((resolve) => setImmediate(resolve));
      state.addons[0] = change === "grant"
        ? { ...state.addons[0]!, allowedUsers: [] }
        : { ...state.addons[0]!, manifest: { ...state.addons[0]!.manifest, version: "2" } };
      gate.release();
      const result = await resolving;

      assert.equal(result.status, "cancelled");
      assert.equal(probes, 1);
    });
  }
});

test("a provider changed to catalog during inspection is cancelled", async () => {
  const gate = deferred();
  const state = { users: [user()], addons: [addon("one")] };
  let probes = 0;
  const resolver = resolverFor(state, {
    listStreams: async () => [stream("one", "https://media.example/one.mkv")],
    inspect: async () => {
      probes += 1;
      await gate.promise;
      return media();
    },
  });

  const resolving = resolver(input(snapshot(), new AbortController().signal));
  await new Promise((resolve) => setImmediate(resolve));
  state.addons[0] = { ...state.addons[0]!, role: "catalog" };
  gate.release();
  const result = await resolving;

  assert.equal(result.status, "cancelled");
  assert.equal(probes, 1);
  assert.equal("stream" in result, false);
});

test("removing the stream resource during listing or inspection denies the old source", async () => {
  for (const phase of ["listing", "inspection"] as const) {
    await test(`during ${phase}`, async () => {
      const gate = deferred();
      const state = { users: [user()], addons: [addon("one")] };
      let probes = 0;
      const resolver = resolverFor(state, {
        listStreams: async () => {
          if (phase === "listing") await gate.promise;
          return [stream("one", "https://media.example/one.mkv")];
        },
        inspect: async () => {
          probes += 1;
          if (phase === "inspection") await gate.promise;
          return media();
        },
      });

      const resolving = resolver(input(snapshot(), new AbortController().signal));
      await new Promise((resolve) => setImmediate(resolve));
      state.addons[0] = {
        ...state.addons[0]!,
        manifest: { ...state.addons[0]!.manifest, resources: [] },
      };
      gate.release();
      const result = await resolving;

      assert.equal(result.status, phase === "listing" ? "accessDenied" : "cancelled");
      assert.equal(probes, phase === "inspection" ? 1 : 0);
      assert.equal("stream" in result, false);
    });
  }
});

test("revoking the selected subtitle addon during a probe denies the selected result", async () => {
  const gate = deferred();
  const state = { users: [user()], addons: [addon("one"), subtitleAddon()] };
  const resolver = resolverFor(state, {
    listStreams: async () => [stream("one", "https://media.example/one.mkv")],
    listSubtitles: async () => [
      { addonKey: "subs", url: "https://subs.example/episode.srt", lang: "en" },
    ],
    inspect: async () => {
      await gate.promise;
      return media();
    },
  });

  const resolving = resolver(input(snapshot(["addon:one"], { subtitleMode: "required" }),
    new AbortController().signal));
  await new Promise((resolve) => setImmediate(resolve));
  state.addons[1] = { ...state.addons[1]!, allowedUsers: [] };
  gate.release();
  const result = await resolving;

  assert.equal(result.status, "accessDenied");
  assert.equal("stream" in result, false);
});

test("cursor continuation survives signed stream URL rotation", async () => {
  const listing = (token: string): StreamItem[] => [
    ...Array.from({ length: TRAVEL_INSPECTION_BUDGET }, (_entry, index) =>
      stream("one", `https://media.example/sample-${index}.mkv?token=${token}`, index + 1, {
        title: `Sample ${index}`,
      })),
    stream("one", `https://media.example/episode.mkv?token=${token}`, 100, {
      title: "Full episode",
    }),
  ];
  let currentListing = listing("first-secret");
  const calls: string[] = [];
  const state = { users: [user()], addons: [addon("one")] };
  const resolver = resolverFor(state, {
    listStreams: async () => currentListing,
    inspect: async (item) => {
      calls.push(item.url!);
      return media(item.title === "Full episode" ? 480 : 360);
    },
  });

  const first = await resolver(input(snapshot(), new AbortController().signal));
  assert.equal(first.status, "budgetExhausted");
  if (first.status !== "budgetExhausted") return;
  assert.doesNotMatch(JSON.stringify(first), /media\.example|first-secret/);

  const secondListing = listing("second-secret");
  currentListing = secondListing;
  calls.length = 0;
  const second = await resolver(input(snapshot(), new AbortController().signal, {
    cursor: first.cursor,
  }));

  assert.equal(second.status, "selected");
  if (second.status !== "selected") return;
  assert.equal(second.stream, secondListing[TRAVEL_INSPECTION_BUDGET]);
  assert.equal(calls[0], secondListing[TRAVEL_INSPECTION_BUDGET]!.url);
});

test("abort during listing returns cancelled without subtitles or probes", async () => {
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

  const resolving = resolver(input(snapshot(["addon:one"], { subtitleMode: "optional" }),
    controller.signal));
  controller.abort();
  gate.release();
  const result = await resolving;

  assert.equal(result.status, "cancelled");
  assert.equal(subtitleLookups, 0);
  assert.equal(probes, 0);
});

test("a torrent-only row is not replaced by a torrent or Real-Debrid fallback", async () => {
  const state = { users: [user()], addons: [addon("one")] };
  let probes = 0;
  const resolver = resolverFor(state, {
    listStreams: async () => [{
      addonKey: "one",
      infoHash: "a".repeat(40),
      name: "Torrent release",
    }],
    inspect: async () => {
      probes += 1;
      return media();
    },
  });

  const result = await resolver(input(snapshot(), new AbortController().signal));

  assert.equal(result.status, "noMatch");
  assert.equal(probes, 0);
  assert.equal("settings" in result, false);
});
