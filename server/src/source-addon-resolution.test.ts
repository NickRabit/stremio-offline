import assert from "node:assert/strict";
import test from "node:test";
import type { MediaInfo } from "./probe.js";
import {
  materializeSourceAdmissionPolicy,
  type SourceAdmissionSnapshotV1,
} from "./source-admission.js";
import {
  inspectedAddonSourceEvidence,
  listedAddonSourceEvidence,
} from "./source-addon-evidence.js";
import { resolveAddonSourceSelection } from "./source-addon-resolution.js";
import {
  SOURCE_PROFILE_DEFINITIONS,
  SOURCE_PROFILE_IDS,
} from "./source-profiles.js";
import type { StreamItem, SubtitleItem } from "./types.js";

const definition = SOURCE_PROFILE_DEFINITIONS.find((candidate) =>
  candidate.id === SOURCE_PROFILE_IDS.providerPriority);
assert.ok(definition);

interface SnapshotOptions {
  readonly audioMode?: "strict" | "listed" | "preferred";
  readonly preferredAudio?: string;
  readonly fallbackAudio?: string;
  readonly subtitleMode?: "off" | "optional" | "required";
  readonly preferredSubtitle?: string;
  readonly fallbackSubtitle?: string;
}

const snapshot = (options: SnapshotOptions = {}): SourceAdmissionSnapshotV1 => {
  const providerKeys = ["addon:one"];
  const source = structuredClone(definition.policy);
  source.constraints.audio = {
    mode: options.audioMode ?? "preferred",
    preferred: { code: options.preferredAudio ?? "en" },
    ...(options.fallbackAudio === undefined ? {} : { fallback: { code: options.fallbackAudio } }),
  };
  const subtitleMode = options.subtitleMode ?? "optional";
  source.constraints.subtitles = subtitleMode === "off"
    ? { mode: "off" }
    : {
      mode: subtitleMode,
      preferred: { code: options.preferredSubtitle ?? "en" },
      ...(options.fallbackSubtitle === undefined
        ? {}
        : { fallback: { code: options.fallbackSubtitle } }),
    };
  return {
    schemaVersion: 1,
    profile: { id: SOURCE_PROFILE_IDS.providerPriority, revision: 1 },
    operation: "downloadToLibrary",
    providerKeys,
    policy: materializeSourceAdmissionPolicy(source, providerKeys, {}),
  };
};

const torrent = (overrides: Partial<StreamItem> = {}): StreamItem => ({
  addonKey: "one",
  infoHash: "a".repeat(40),
  fileIdx: 0,
  name: "English release",
  ...overrides,
});

const media = (input: {
  readonly audio?: readonly (string | undefined)[];
  readonly subtitles?: readonly (string | undefined)[];
} = {}): MediaInfo => ({
  container: "matroska",
  duration: 3_600,
  video: { codec: "h264", height: 1_080 },
  audioTracks: (input.audio ?? ["en"]).map((language, index) => ({
    index,
    codec: "aac",
    ...(language === undefined ? {} : { language }),
  })),
  subtitleTracks: (input.subtitles ?? []).map((language, index) => ({
    index,
    codec: "subrip",
    ...(language === undefined ? {} : { language }),
  })),
});

test("inspected selection keeps Travel track, fallback and embedded subtitle behavior", () => {
  const stream = torrent();
  const listed = listedAddonSourceEvidence({
    providerKey: "addon:one",
    stream,
    providerResponseIndex: 0,
    available: true,
  });
  assert.ok(listed);
  const candidate = inspectedAddonSourceEvidence(listed, media({
    audio: ["cs", "en"],
    subtitles: ["cs"],
  }));

  const resolved = resolveAddonSourceSelection({
    snapshot: snapshot({
      preferredAudio: "cs",
      preferredSubtitle: "cs",
    }),
    candidate,
    stream,
    info: media({ audio: ["cs", "en"], subtitles: ["cs"] }),
    externalSubtitles: [],
    checkedCandidates: 2,
  });

  assert.ok(resolved);
  assert.equal(resolved.resolution.checkedCandidates, 2);
  assert.equal(resolved.resolution.audioLanguage, "cs");
  assert.equal(resolved.resolution.audioTrack, 0);
  assert.equal(resolved.resolution.audioEvidence, "probe");
  assert.equal(resolved.resolution.fallbackUsed, false);
  assert.equal(resolved.resolution.subtitleLanguage, "cs");
  assert.equal(resolved.resolution.subtitleTrack, 0);
  assert.equal(resolved.resolution.subtitleSource, "embedded");
  assert.equal(resolved.resolution.subtitleStatus, "ready");
  assert.equal(resolved.subtitle, undefined);
});

test("a torrent without inspection uses listed preferred audio and no fabricated track", () => {
  const stream = torrent();
  const candidate = listedAddonSourceEvidence({
    providerKey: "addon:one",
    stream,
    providerResponseIndex: 0,
    available: true,
  });
  assert.ok(candidate);

  const resolved = resolveAddonSourceSelection({
    snapshot: snapshot({
      preferredAudio: "en",
      fallbackAudio: "cs",
      subtitleMode: "off",
    }),
    candidate,
    stream,
    externalSubtitles: [],
    checkedCandidates: 0,
  });

  assert.ok(resolved);
  assert.equal(resolved.resolution.audioLanguage, "en");
  assert.equal(resolved.resolution.audioEvidence, "listing");
  assert.equal(resolved.resolution.fallbackUsed, false);
  assert.equal("audioTrack" in resolved.resolution, false);
  assert.equal("subtitleTrack" in resolved.resolution, false);
});

test("torrent preferred mode falls back to the first listed language without inspection", () => {
  const stream = torrent({ name: "Czech release" });
  const candidate = listedAddonSourceEvidence({
    providerKey: "addon:one",
    stream,
    providerResponseIndex: 0,
    available: true,
  });
  assert.ok(candidate);

  const resolved = resolveAddonSourceSelection({
    snapshot: snapshot({
      preferredAudio: "en",
      fallbackAudio: "de",
      subtitleMode: "off",
    }),
    candidate,
    stream,
    externalSubtitles: [],
    checkedCandidates: 0,
  });

  assert.ok(resolved);
  assert.equal(resolved.resolution.audioLanguage, "cs");
  assert.equal(resolved.resolution.audioEvidence, "listing");
  assert.equal(resolved.resolution.fallbackUsed, true);
  assert.equal("audioTrack" in resolved.resolution, false);
});

test("strict mode without inspection and required missing subtitles return undefined", () => {
  const streamed = torrent();
  const candidate = listedAddonSourceEvidence({
    providerKey: "addon:one",
    stream: streamed,
    providerResponseIndex: 0,
    available: true,
  });
  assert.ok(candidate);

  assert.equal(resolveAddonSourceSelection({
    snapshot: snapshot({ audioMode: "strict", subtitleMode: "off" }),
    candidate,
    stream: streamed,
    externalSubtitles: [],
    checkedCandidates: 0,
  }), undefined);
  assert.equal(resolveAddonSourceSelection({
    snapshot: snapshot({ subtitleMode: "required", preferredSubtitle: "en" }),
    candidate,
    stream: streamed,
    externalSubtitles: [],
    checkedCandidates: 0,
  }), undefined);
});

test("listed mode without a preferred or fallback listing cannot resolve audio", () => {
  const stream = torrent({ name: "Czech release" });
  const candidate = listedAddonSourceEvidence({
    providerKey: "addon:one",
    stream,
    providerResponseIndex: 0,
    available: true,
  });
  assert.ok(candidate);
  assert.equal(resolveAddonSourceSelection({
    snapshot: snapshot({ audioMode: "listed", subtitleMode: "off" }),
    candidate,
    stream,
    externalSubtitles: [],
    checkedCandidates: 0,
  }), undefined);
});

test("optional external subtitles prefer stream-owned rows and report listing-only status", () => {
  const owned: SubtitleItem = {
    url: "https://subs.example/owned.srt",
    lang: "Czech",
    title: "Owned",
  };
  const global: SubtitleItem = {
    url: "https://subs.example/global.srt",
    lang: "Czech",
    addonKey: "subs",
    title: "Global",
  };
  const stream = torrent({ subtitles: [owned] });
  const candidate = listedAddonSourceEvidence({
    providerKey: "addon:one",
    stream,
    providerResponseIndex: 0,
    available: true,
    externalSubtitles: [global],
  });
  assert.ok(candidate);

  const resolved = resolveAddonSourceSelection({
    snapshot: snapshot({
      preferredAudio: "en",
      subtitleMode: "optional",
      preferredSubtitle: "en",
      fallbackSubtitle: "cs",
    }),
    candidate,
    stream,
    externalSubtitles: [global],
    checkedCandidates: 0,
  });

  assert.ok(resolved);
  assert.equal(resolved.subtitle, owned);
  assert.equal(resolved.resolution.subtitleLanguage, "cs");
  assert.equal(resolved.resolution.subtitleSource, "addon");
  assert.equal(resolved.resolution.subtitleStatus, "ready");
});
