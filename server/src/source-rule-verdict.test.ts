import assert from "node:assert/strict";
import { test } from "node:test";
import { listedLocalCopyEvidence } from "./local-copy-admission.js";
import { materializeSourceAdmissionPolicy, type SourceAdmissionSnapshotV1 } from "./source-admission.js";
import { listedAddonSourceEvidence } from "./source-addon-evidence.js";
import type { SourceEvidenceCandidateV1 } from "./source-evidence.js";
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
  const { bytes: _ignored, ...constraints } = policy.constraints;
  return {
    schemaVersion: 1,
    profile: { id: "rules-profile", revision: 1, template: "rules" },
    operation: "play",
    providerKeys,
    policy: { ...policy, constraints },
  };
};

const addon = (
  sourceId: string,
  stream: StreamItem,
  providerKey = "addon:a",
): SourceEvidenceCandidateV1 => listedAddonSourceEvidence({
  providerKey,
  stream,
  providerResponseIndex: 0,
  available: true,
})!;

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

test("playback ignores a rule's file-size limit", () => {
  const source = addon("large", {
    url: "https://cdn.example/large-1080p.mp4",
    name: "Czech 1080p",
    behaviorHints: { videoSize: 40_000_000_000 },
  });
  const verdict = ruleVerdicts(snapshot(rule({
    resolution: { min: 720, max: 1080 },
    sizeGb: { episode: { min: null, max: 4 }, movie: { min: null, max: 4 } },
  })), [source]).get(source.sourceId)!;

  assert.equal(verdict.status, "meets");
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
  assert.ok(localVerdict.rank[3]! < remoteVerdict.rank[3]!);
  assert.ok(remoteVerdict.rank[3]! < addonVerdict.rank[3]!);
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

  assert.ok(verdicts.get(addonCandidate.sourceId)!.rank[3]!
    < verdicts.get(remoteCandidate.sourceId)!.rank[3]!);
  assert.ok(verdicts.get(remoteCandidate.sourceId)!.rank[3]!
    < verdicts.get(local.sourceId)!.rank[3]!);
});
