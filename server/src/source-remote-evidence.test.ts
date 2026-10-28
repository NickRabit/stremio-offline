import assert from "node:assert/strict";
import test from "node:test";
import {
  remoteDownloadKey,
  type RemoteDownloadReference,
} from "./media-server-download.js";
import type { ProviderVersion } from "./media-server-provider.js";
import { remoteSourceEvidence } from "./source-remote-evidence.js";

const reference: RemoteDownloadReference = {
  schemaVersion: 1,
  ownerUserId: "usr_00000001",
  connectionId: `mconn_${"1".repeat(32)}`,
  libraryId: `rlib_${"2".repeat(32)}`,
  generation: 7,
  provider: "jellyfin",
  serverId: "server-1",
  accountId: "account-1",
  itemId: "item-1",
  mediaSourceId: "version-1",
};

test("remote evidence maps provider metadata into the shared evidence contract", () => {
  const version: ProviderVersion = {
    id: "version-1",
    name: "Movie.1080p.HDCAM",
    size: 4_000_000_000,
    durationTicks: 36_000_000_000,
    videoWidth: 1920,
    videoHeight: 800,
    audioLanguages: ["cs", undefined],
    embeddedSubtitleLanguages: ["en"],
    externalSubtitles: [
      { index: 2, language: "cze" },
      { index: 3, language: "not-a-language" },
    ],
  };
  const candidate = remoteSourceEvidence({
    providerKey: `remote:${reference.libraryId}`,
    reference,
    version,
    providerResponseIndex: 4,
  });

  assert.equal(candidate.sourceId, `remote:${remoteDownloadKey(reference)}`);
  assert.equal(candidate.providerKey, `remote:${reference.libraryId}`);
  assert.equal(candidate.providerClass, "remote");
  assert.equal(candidate.sourceKind, "mediaServerOriginal");
  assert.deepEqual(candidate.capabilities, ["downloadToLibrary"]);
  assert.equal(candidate.available, true);
  assert.equal(candidate.providerResponseIndex, 4);
  assert.deepEqual(candidate.facts.bytes, { evidence: "providerMetadata", value: 4_000_000_000 });
  assert.deepEqual(candidate.facts.durationSeconds, { evidence: "providerMetadata", value: 3_600 });
  assert.deepEqual(candidate.facts.heightPixels, { evidence: "providerMetadata", value: 1080 });
  assert.deepEqual(candidate.facts.audio.tracks, { evidence: "providerMetadata", value: ["cs", undefined] });
  assert.deepEqual(candidate.facts.audio.listed, { evidence: "providerMetadata", value: ["cs"] });
  assert.deepEqual(candidate.facts.embeddedSubtitles, { evidence: "providerMetadata", value: ["en"] });
  assert.deepEqual(candidate.facts.externalSubtitles, {
    evidence: "providerMetadata",
    value: ["cs", undefined],
  });
  assert.deepEqual(candidate.facts.releaseKind, { evidence: "listed", value: "cam" });
  assert.deepEqual(candidate.facts.sampleOrTrailer, { evidence: "unknown" });
  assert.equal(candidate.continuationIdentity?.reusableRejection, true);
  assert.doesNotMatch(JSON.stringify(candidate), /https?:|token|secret|media-server:/i);
});

test("remote evidence leaves absent metadata unknown and uses a stable continuation identity", () => {
  const version = { id: "version-1", name: "Ordinary episode" };
  const first = remoteSourceEvidence({
    providerKey: `remote:${reference.libraryId}`,
    reference,
    version,
    providerResponseIndex: 0,
  });
  const second = remoteSourceEvidence({
    providerKey: `remote:${reference.libraryId}`,
    reference,
    version,
    providerResponseIndex: 9,
  });

  assert.deepEqual(first.continuationIdentity, second.continuationIdentity);
  assert.deepEqual(first.facts.bytes, { evidence: "unknown" });
  assert.deepEqual(first.facts.durationSeconds, { evidence: "unknown" });
  assert.deepEqual(first.facts.heightPixels, { evidence: "unknown" });
  assert.deepEqual(first.facts.audio, {
    listed: { evidence: "unknown" },
    tracks: { evidence: "unknown" },
  });
  assert.deepEqual(first.facts.embeddedSubtitles, { evidence: "unknown" });
  assert.deepEqual(first.facts.externalSubtitles, { evidence: "unknown" });
  assert.deepEqual(first.facts.releaseKind, { evidence: "listed", value: null });
});
