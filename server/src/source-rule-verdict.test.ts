import assert from "node:assert/strict";
import { test } from "node:test";
import { listedLocalCopyEvidence } from "./local-copy-admission.js";
import { materializeSourceAdmissionPolicy, type SourceAdmissionSnapshotV1 } from "./source-admission.js";
import { listedAddonSourceEvidence } from "./source-addon-evidence.js";
import { rankEligibleSources, type SourceEvidenceCandidateV1 } from "./source-evidence.js";
import { parseDownloadRules, rulesPolicy, type DownloadRules } from "./download-rules.js";
import { ruleVerdicts } from "./source-rule-verdict.js";
import type { StreamItem } from "./types.js";

const providers = ["local", "remote:remote-1", "addon:a", "addon:b"];

const rule = (overrides: Partial<DownloadRules> = {}): DownloadRules => parseDownloadRules({
  addons: { scope: "all", order: "viewer" },
  torrents: true,
  resolution: { min: null, max: null },
  audio: { mode: "prefer", language: "cs", fallback: null },
  subtitles: "ifAvailable",
  subtitleLanguage: "en",
  sizeGb: {
    episode: { min: null, max: null },
    movie: { min: null, max: null },
  },
  skipCinema: true,
  preference: ["language", "resolutionHigher", "addonOrder", "smaller"],
  ...overrides,
});

const snapshot = (
  rules: DownloadRules,
  providerKeys = providers,
): SourceAdmissionSnapshotV1 => {
  const policy = materializeSourceAdmissionPolicy(
    rulesPolicy(rules, "movie"),
    providerKeys,
    { audioLanguage: "cs", subtitleLanguage: "en" },
  );
  return {
    schemaVersion: 1,
    profile: { id: "rules-profile", revision: 1, template: "rules" },
    operation: "play",
    providerKeys,
    policy: {
      ...policy,
      criteria: policy.criteria.map((criterion) =>
        rules.addons.order === "viewer" && criterion.kind === "providerOrder"
          ? { kind: "providerOrder", from: "viewer" }
          : criterion),
    },
  };
};

const addon = (
  sourceId: string,
  stream: StreamItem,
  providerKey = "addon:a",
  providerResponseIndex = 0,
): SourceEvidenceCandidateV1 => listedAddonSourceEvidence({
  providerKey,
  stream,
  providerResponseIndex,
  available: true,
})!;

const compareRanks = (left: number[], right: number[]): number => {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference) return difference;
  }
  return left.length - right.length;
};

test("a preferred Czech addon listing ranks before English", () => {
  const czech = addon("czech", { url: "https://cdn.example/czech-1080p.mp4", name: "Czech 1080p" });
  const english = addon("english", { url: "https://cdn.example/english-1080p.mp4", name: "English 1080p" }, "addon:b");
  const verdicts = ruleVerdicts(snapshot(rule()), [english, czech]);

  assert.equal(verdicts.get(czech.sourceId)?.status, "meets");
  assert.equal(verdicts.get(english.sourceId)?.status, "meets");
  assert.ok(verdicts.get(czech.sourceId)!.rank < verdicts.get(english.sourceId)!.rank);
});

test("an only-language rule breaks a known English addon listing", () => {
  const czech = addon("czech", { url: "https://cdn.example/czech-1080p.mp4", name: "Czech 1080p" });
  const english = addon("english", { url: "https://cdn.example/english-1080p.mp4", name: "English 1080p" }, "addon:b");
  const verdicts = ruleVerdicts(snapshot(rule({
    audio: { mode: "only", language: "cs", fallback: null },
  })), [czech, english]);

  assert.equal(verdicts.get(czech.sourceId)?.status, "meets");
  assert.deepEqual(verdicts.get(english.sourceId), {
    profileId: "rules-profile",
    status: "breaks",
    reasons: ["language"],
    rank: verdicts.get(english.sourceId)!.rank,
  });
});

test("a low-resolution source breaks with a resolutionLow reason", () => {
  const source = addon("sd", { url: "https://cdn.example/sd.mp4", name: "Czech 480p" });
  const verdict = ruleVerdicts(snapshot(rule({ resolution: { min: 720, max: 1080 } })), [source])
    .get(source.sourceId)!;

  assert.equal(verdict.status, "breaks");
  assert.deepEqual(verdict.reasons, ["resolutionLow"]);
});

test("a CAM source breaks with a cinema reason", () => {
  const source = addon("cam", { url: "https://cdn.example/new-movie.mp4", name: "Movie CAM 1080p" });
  const verdict = ruleVerdicts(snapshot(rule()), [source]).get(source.sourceId)!;

  assert.equal(verdict.status, "breaks");
  assert.deepEqual(verdict.reasons, ["cinema"]);
});

test("playback reports codec and HDR rule breaks", () => {
  const codec = addon("codec", {
    url: "https://cdn.example/codec.mp4",
    name: "Czech 1080p HEVC",
  });
  const hdr = addon("hdr", {
    url: "https://cdn.example/hdr.mp4",
    name: "Czech 1080p HDR10",
  }, "addon:a", 1);
  const verdicts = ruleVerdicts(snapshot(rule({ videoAvoid: ["hevc", "hdr"] })), [codec, hdr]);

  assert.deepEqual(verdicts.get(codec.sourceId)?.reasons, ["codec"]);
  assert.deepEqual(verdicts.get(hdr.sourceId)?.reasons, ["hdr"]);
});

test("playback breaks a known size outside the rule's file-size limit", () => {
  const source = addon("large", {
    url: "https://cdn.example/large-1080p.mp4",
    name: "Czech 1080p",
    behaviorHints: { videoSize: 40_000_000_000 },
  });
  const verdict = ruleVerdicts(snapshot(rule({
    resolution: { min: 720, max: 1080 },
    sizeGb: { episode: { min: null, max: 4 }, movie: { min: null, max: 4 } },
  })), [source]).get(source.sourceId)!;

  assert.equal(verdict.status, "breaks");
  assert.deepEqual(verdict.reasons, ["size"]);
});

test("size status comes before larger-file preference and keeps the source within the range", () => {
  const candidates = [
    addon("55", {
      url: "https://cdn.example/55.mp4",
      name: "Czech English 4K",
      behaviorHints: { videoSize: 55_200_000_000 },
    }),
    addon("21.8", {
      url: "https://cdn.example/21-8.mp4",
      name: "Czech English 4K",
      behaviorHints: { videoSize: 21_800_000_000 },
    }, "addon:a", 1),
    addon("20.8", {
      url: "https://cdn.example/20-8.mp4",
      name: "Czech English 4K",
      behaviorHints: { videoSize: 20_800_000_000 },
    }, "addon:a", 2),
    addon("10.2", {
      url: "https://cdn.example/10-2.mp4",
      name: "Czech English 4K",
      behaviorHints: { videoSize: 10_200_000_000 },
    }, "addon:a", 3),
  ];
  const verdicts = ruleVerdicts(snapshot(rule({
    resolution: { min: 2160, max: 2160 },
    sizeGb: {
      episode: { min: null, max: null },
      movie: { min: null, max: 20 },
    },
    preference: ["language", "resolutionHigher", "addonOrder", "larger"],
  })), candidates);
  const ranked = [...candidates].sort((left, right) =>
    compareRanks(verdicts.get(left.sourceId)!.rank, verdicts.get(right.sourceId)!.rank));
  const labels = new Map(candidates.map((candidate, index) => [candidate.sourceId, ["55", "21.8", "20.8", "10.2"][index]!]));

  assert.equal(verdicts.get(candidates[3]!.sourceId)?.status, "meets");
  assert.deepEqual(ranked.map((candidate) => labels.get(candidate.sourceId)), ["10.2", "55", "21.8", "20.8"]);
  for (const candidate of candidates.slice(0, 3)) {
    assert.deepEqual(verdicts.get(candidate.sourceId), {
      profileId: "rules-profile",
      status: "breaks",
      reasons: ["size"],
      rank: verdicts.get(candidate.sourceId)!.rank,
    });
  }
});

test("an addon outside the rule scope breaks with provider and a torrent breaks when torrents are off", () => {
  const outOfScope = addon("outside", { url: "https://cdn.example/outside.mp4", name: "Czech 1080p" }, "addon:b");
  const torrent = addon("torrent", {
    infoHash: "0123456789abcdef0123456789abcdef01234567",
    fileIdx: 0,
    name: "Czech 1080p",
  }, "addon:a", 1);
  const verdicts = ruleVerdicts(snapshot(rule({ torrents: false }), providers.filter((key) => key !== "addon:b")), [
    outOfScope,
    torrent,
  ]);

  assert.deepEqual(verdicts.get(outOfScope.sourceId)?.reasons, ["provider"]);
  assert.deepEqual(verdicts.get(torrent.sourceId)?.reasons, ["torrent"]);
});

test("an unknown language under an only rule remains unverified", () => {
  const source = addon("unknown", { url: "https://cdn.example/unknown-1080p.mp4", name: "1080p" });
  const verdict = ruleVerdicts(snapshot(rule({
    audio: { mode: "only", language: "cs", fallback: null },
  })), [source]).get(source.sourceId)!;

  assert.equal(verdict.status, "unverified");
  assert.deepEqual(verdict.reasons, []);
});

test("provider rank is local, then remote, then addon and ranks are padded equally", () => {
  const local = listedLocalCopyEvidence({ key: "lib_00000001/movie.mkv", size: 10 }, 0);
  const remote = addon("remote", { url: "https://media.example/movie.mp4", name: "Original" }, "remote:remote-1");
  const remoteCandidate: SourceEvidenceCandidateV1 = {
    ...remote,
    providerClass: "remote",
    sourceKind: "mediaServerOriginal",
  };
  const addonCandidate = addon("addon", { url: "https://cdn.example/movie.mp4", name: "Original" });
  const verdicts = ruleVerdicts(snapshot(rule()), [local, remoteCandidate, addonCandidate]);

  const localVerdict = verdicts.get(local.sourceId)!;
  const remoteVerdict = verdicts.get(remoteCandidate.sourceId)!;
  const addonVerdict = verdicts.get(addonCandidate.sourceId)!;
  assert.equal(new Set([localVerdict.rank.length, remoteVerdict.rank.length, addonVerdict.rank.length]).size, 1);
  assert.equal(localVerdict.rank[0], 0);
  assert.equal(remoteVerdict.rank[0], 1);
  assert.equal(addonVerdict.rank[0], 1);
  assert.ok(localVerdict.rank[4]! < remoteVerdict.rank[4]!);
  assert.ok(remoteVerdict.rank[4]! < addonVerdict.rank[4]!);
});

test("an explicit mixed provider order determines the verdict ranks", () => {
  const local = listedLocalCopyEvidence({ key: "lib_00000001/movie.mkv", size: 10 }, 0);
  const remote = addon("remote", { url: "https://media.example/movie.mp4", name: "Original" }, "remote:remote-1");
  const remoteCandidate: SourceEvidenceCandidateV1 = {
    ...remote,
    providerClass: "remote",
    sourceKind: "mediaServerOriginal",
  };
  const addonCandidate = addon("addon", { url: "https://cdn.example/movie.mp4", name: "Original" });
  const providerKeys = ["addon:a", "remote:remote-1", "local"];
  const verdicts = ruleVerdicts(
    snapshot(rule({
      addons: { scope: "all", order: { explicit: ["a", "remote:remote-1", "local"] } },
    }), providerKeys),
    [local, remoteCandidate, addonCandidate],
  );

  assert.equal(verdicts.get(local.sourceId)!.rank[0], 0);
  assert.equal(verdicts.get(remoteCandidate.sourceId)!.rank[0], 0);
  assert.equal(verdicts.get(addonCandidate.sourceId)!.rank[0], 0);
  assert.ok(verdicts.get(addonCandidate.sourceId)!.rank[4]!
    < verdicts.get(remoteCandidate.sourceId)!.rank[4]!);
  assert.ok(verdicts.get(remoteCandidate.sourceId)!.rank[4]!
    < verdicts.get(local.sourceId)!.rank[4]!);
});

test("viewer provider order keeps a breaking local copy first while an explicit order ranks it last", () => {
  const local = listedLocalCopyEvidence({
    key: "lib_00000001/movie.Czech.1080p.mkv",
    size: 30_000_000_000,
  }, 0);
  const source = addon("addon", {
    url: "https://cdn.example/movie.mp4",
    name: "Czech 1080p",
    behaviorHints: { videoSize: 10_000_000_000 },
  });
  const sized = rule({
    sizeGb: {
      episode: { min: null, max: null },
      movie: { min: null, max: 20 },
    },
  });
  const viewer = ruleVerdicts(snapshot(sized), [source, local]);
  assert.deepEqual(viewer.get(local.sourceId)?.reasons, ["size"]);
  assert.ok(compareRanks(viewer.get(local.sourceId)!.rank, viewer.get(source.sourceId)!.rank) < 0);

  const explicitKeys = ["addon:a", "addon:b", "remote:remote-1", "local"];
  const firstAddon = addon("first", { url: "https://cdn.example/first.mp4", name: "Czech 1080p" });
  const explicitLocal = { ...local, sourceId: "local-explicit" };
  const explicit = ruleVerdicts(snapshot(rule({
    ...sized,
    addons: { scope: "all", order: { explicit: ["a", "b", "remote:remote-1", "local"] } },
  }), explicitKeys), [
    firstAddon,
    explicitLocal,
  ]);
  assert.ok(compareRanks(explicit.get(firstAddon.sourceId)!.rank, explicit.get(explicitLocal.sourceId)!.rank) < 0);
});

test("equal sources receive distinct tie ordinals in compareFinalTie order", () => {
  const candidates = [
    addon("z", { url: "https://cdn.example/z.mp4", name: "Czech 1080p" }, "addon:a", 0),
    addon("a", { url: "https://cdn.example/a.mp4", name: "Czech 1080p" }, "addon:a", 1),
    addon("m", { url: "https://cdn.example/m.mp4", name: "Czech 1080p" }, "addon:a", 2),
  ];
  const playbackSnapshot = snapshot(rule());
  const verdicts = ruleVerdicts(playbackSnapshot, candidates);
  const ticks = candidates.map((candidate) => verdicts.get(candidate.sourceId)!.rank.at(-1));
  assert.equal(new Set(ticks).size, candidates.length);
  const ranked = rankEligibleSources(playbackSnapshot, candidates.map((candidate) => ({
    ...candidate,
    capabilities: ["play", "downloadToLibrary"],
  }))).map((entry) => entry.candidate.sourceId);
  const finalTieOrder = [...candidates]
    .sort((left, right) => left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0)
    .map((candidate) => candidate.sourceId);
  assert.deepEqual(ranked, finalTieOrder);
  assert.deepEqual(ranked.map((sourceId) => verdicts.get(sourceId)!.rank.at(-1)), [0, 1, 2]);
});

test("a local file name is listed language evidence", () => {
  const local = listedLocalCopyEvidence({
    key: "lib_00000001/movie.Czech.1080p.HEVC.HDR10.mkv",
    size: 10_000_000_000,
  }, 0, "movie.Czech.1080p.HEVC.HDR10.mkv");

  assert.deepEqual(local.facts.audio.listed, { evidence: "listed", value: ["cs"] });
  assert.deepEqual(local.facts.videoCodec, { evidence: "listed", value: "hevc" });
  assert.deepEqual(local.facts.videoRange, { evidence: "listed", value: "hdr" });
  const verdict = ruleVerdicts(snapshot(rule({
    audio: { mode: "only", language: "cs", fallback: null },
  })), [local]).get(local.sourceId)!;
  assert.equal(verdict.status, "meets");
});
