import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseSourcePolicyV1,
  SourcePolicyValidationError,
  type SourcePolicyV1,
} from "./source-policy.js";

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

const recommended = () => ({
  schemaVersion: 1,
  scope: { mode: "allAvailable" },
  constraints: {
    sourceKinds: ["localFile", "mediaServerOriginal", "http", "torrent"],
    audio: {
      mode: "preferred",
      preferred: { code: "Czech" },
      fallback: { code: "eng" },
    },
    subtitles: {
      mode: "optional",
      preferred: { preference: "subtitle" },
    },
  },
  criteria: [
    { kind: "providerClass", order: ["local", "remote", "addon"] },
    { kind: "audioTier" },
    { kind: "providerOrder", from: "viewer" },
    { kind: "size", direction: "desc" },
  ],
  nextEpisode: "profile",
  existingLocalCopy: "any",
});

const providerPriority = () => ({
  schemaVersion: 1,
  scope: { mode: "selected", providerKeys: ["addon:zeta", "addon:alpha"] },
  constraints: {
    sourceKinds: ["http", "torrent"],
    audio: {
      mode: "strict",
      preferred: { code: "cze" },
      fallback: { code: "English" },
    },
    subtitles: {
      mode: "required",
      preferred: { preference: "subtitle" },
      fallback: { code: "eng" },
    },
  },
  criteria: [
    { kind: "providerClass", order: ["remote", "addon", "local"] },
    { kind: "providerOrder", keys: ["addon:alpha", "addon:zeta"] },
    { kind: "audioTier" },
    { kind: "size", direction: "desc" },
  ],
  nextEpisode: "sameProviderThenNearestSize",
  existingLocalCopy: "any",
});

const travel = () => ({
  schemaVersion: 1,
  scope: { mode: "allAvailable" },
  constraints: {
    sourceKinds: ["mediaServerOriginal", "http"],
    audio: {
      mode: "preferred",
      preferred: { code: "cz" },
      fallback: { code: "ENG" },
    },
    subtitles: {
      mode: "optional",
      preferred: { preference: "subtitle" },
      fallback: { code: "Czech" },
    },
    bytes: { max: 8_000_000_000 },
    durationSeconds: { min: 1_200, max: 10_800 },
    heightPixels: { min: 480 },
  },
  criteria: [
    { kind: "audioTier" },
    { kind: "size", direction: "asc" },
    { kind: "resolution", direction: "desc" },
  ],
  nextEpisode: "profile",
  existingLocalCopy: "meetsRequirements",
});

test("Recommended parses into a canonical copy with normalized languages", () => {
  const input = deepFreeze(recommended());
  const before = structuredClone(input);
  const expected: SourcePolicyV1 = {
    schemaVersion: 1,
    scope: { mode: "allAvailable" },
    constraints: {
      sourceKinds: ["localFile", "mediaServerOriginal", "http", "torrent"],
      audio: {
        mode: "preferred",
        preferred: { code: "cs" },
        fallback: { code: "en" },
      },
      subtitles: {
        mode: "optional",
        preferred: { preference: "subtitle" },
      },
    },
    criteria: [
      { kind: "providerClass", order: ["local", "remote", "addon"] },
      { kind: "audioTier" },
      { kind: "providerOrder", from: "viewer" },
      { kind: "size", direction: "desc" },
    ],
    nextEpisode: "profile",
    existingLocalCopy: "any",
  };

  const parsed = parseSourcePolicyV1(input);
  assert.deepEqual(parsed, expected);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.constraints.sourceKinds, input.constraints.sourceKinds);
  assert.notEqual(parsed.criteria, input.criteria);
  assert.deepEqual(input, before);
});

test("Provider priority parses its ordered provider lists", () => {
  const input = deepFreeze(providerPriority());
  const before = structuredClone(input);
  const expected: SourcePolicyV1 = {
    schemaVersion: 1,
    scope: { mode: "selected", providerKeys: ["addon:zeta", "addon:alpha"] },
    constraints: {
      sourceKinds: ["http", "torrent"],
      audio: {
        mode: "strict",
        preferred: { code: "cs" },
        fallback: { code: "en" },
      },
      subtitles: {
        mode: "required",
        preferred: { preference: "subtitle" },
        fallback: { code: "en" },
      },
    },
    criteria: [
      { kind: "providerClass", order: ["remote", "addon", "local"] },
      { kind: "providerOrder", keys: ["addon:alpha", "addon:zeta"] },
      { kind: "audioTier" },
      { kind: "size", direction: "desc" },
    ],
    nextEpisode: "sameProviderThenNearestSize",
    existingLocalCopy: "any",
  };

  assert.deepEqual(parseSourcePolicyV1(input), expected);
  assert.deepEqual(input, before);
});

test("Travel parses bounded quality and local-copy requirements", () => {
  const input = deepFreeze(travel());
  const before = structuredClone(input);
  const expected: SourcePolicyV1 = {
    schemaVersion: 1,
    scope: { mode: "allAvailable" },
    constraints: {
      sourceKinds: ["mediaServerOriginal", "http"],
      audio: {
        mode: "preferred",
        preferred: { code: "cs" },
        fallback: { code: "en" },
      },
      subtitles: {
        mode: "optional",
        preferred: { preference: "subtitle" },
        fallback: { code: "cs" },
      },
      bytes: { max: 8_000_000_000 },
      durationSeconds: { min: 1_200, max: 10_800 },
      heightPixels: { min: 480 },
    },
    criteria: [
      { kind: "audioTier" },
      { kind: "size", direction: "asc" },
      { kind: "resolution", direction: "desc" },
    ],
    nextEpisode: "profile",
    existingLocalCopy: "meetsRequirements",
  };

  assert.deepEqual(parseSourcePolicyV1(input), expected);
  assert.deepEqual(input, before);
});

test("a zero-byte minimum is accepted and all nested values are copied", () => {
  const input: any = recommended();
  input.constraints.bytes = { min: 0 };
  const parsed = parseSourcePolicyV1(input);

  assert.deepEqual(parsed.constraints.bytes, { min: 0 });
  assert.notEqual(parsed.constraints.audio, input.constraints.audio);
  assert.notEqual(parsed.constraints.bytes, input.constraints.bytes);
  assert.notEqual((parsed.criteria[0] as { order: string[] }).order, (input.criteria[0] as { order: string[] }).order);
});

const valid = recommended;

const invalidCases: Array<{ name: string; value: () => unknown }> = [
  { name: "null", value: () => null },
  { name: "an array at the root", value: () => [] },
  {
    name: "an array subclass in a nested field",
    value: () => {
      const policy: any = valid();
      policy.constraints.sourceKinds = new (class extends Array<string> {})("http");
      return policy;
    },
  },
  { name: "a Date", value: () => new Date() },
  { name: "a class instance", value: () => new (class Policy {})() },
  { name: "a null-prototype object", value: () => Object.assign(Object.create(null), valid()) },
  { name: "an object with an exotic prototype", value: () => Object.assign(Object.create({}), valid()) },
  { name: "a string primitive", value: () => "policy" },
  { name: "a number primitive", value: () => 1 },
  { name: "a boolean primitive", value: () => true },
  {
    name: "an unknown root key containing a provider key",
    value: () => ({ ...valid(), "private-provider.example": true }),
  },
  {
    name: "an unknown scope key",
    value: () => {
      const policy: any = valid();
      policy.scope.extra = true;
      return policy;
    },
  },
  {
    name: "an unknown constraints key",
    value: () => {
      const policy: any = valid();
      policy.constraints.probeBudget = 1;
      return policy;
    },
  },
  {
    name: "an unknown audio key",
    value: () => {
      const policy: any = valid();
      policy.constraints.audio.extra = true;
      return policy;
    },
  },
  {
    name: "an unknown subtitle key",
    value: () => {
      const policy: any = valid();
      policy.constraints.subtitles.extra = true;
      return policy;
    },
  },
  {
    name: "an unknown range key",
    value: () => {
      const policy: any = valid();
      policy.constraints.bytes = { min: 0, unit: "B" };
      return policy;
    },
  },
  {
    name: "an unknown criterion key",
    value: () => {
      const policy: any = valid();
      policy.criteria[1].weight = 3;
      return policy;
    },
  },
  {
    name: "a missing required root key",
    value: () => {
      const policy: any = valid();
      delete policy.existingLocalCopy;
      return policy;
    },
  },
  {
    name: "an unsupported schema version",
    value: () => ({ ...valid(), schemaVersion: 2 }),
  },
  {
    name: "an unsupported scope mode",
    value: () => ({ ...valid(), scope: { mode: "everywhere" } }),
  },
  {
    name: "keys on allAvailable scope",
    value: () => ({ ...valid(), scope: { mode: "allAvailable", providerKeys: [] } }),
  },
  {
    name: "an unsupported source kind",
    value: () => {
      const policy: any = valid();
      policy.constraints.sourceKinds[0] = "ftp";
      return policy;
    },
  },
  {
    name: "an unsupported audio mode",
    value: () => {
      const policy: any = valid();
      policy.constraints.audio.mode = "forgiving";
      return policy;
    },
  },
  {
    name: "an unsupported subtitle mode",
    value: () => {
      const policy: any = valid();
      policy.constraints.subtitles.mode = "sometimes";
      return policy;
    },
  },
  {
    name: "an unsupported criterion kind",
    value: () => {
      const policy: any = valid();
      policy.criteria.push({ kind: "bitrate" });
      return policy;
    },
  },
  {
    name: "an unsupported direction",
    value: () => {
      const policy: any = valid();
      policy.criteria[3].direction = "largest";
      return policy;
    },
  },
  {
    name: "an unsupported next-episode policy",
    value: () => ({ ...valid(), nextEpisode: "previous" }),
  },
  {
    name: "an unsupported local-copy policy",
    value: () => ({ ...valid(), existingLocalCopy: "prefer" }),
  },
  {
    name: "an empty selected scope",
    value: () => ({ ...valid(), scope: { mode: "selected", providerKeys: [] } }),
  },
  {
    name: "a duplicate selected provider",
    value: () => ({ ...valid(), scope: { mode: "selected", providerKeys: ["addon:a", "addon:a"] } }),
  },
  {
    name: "an empty selected provider key",
    value: () => ({ ...valid(), scope: { mode: "selected", providerKeys: [""] } }),
  },
  {
    name: "a whitespace-only selected provider key",
    value: () => ({ ...valid(), scope: { mode: "selected", providerKeys: ["  "] } }),
  },
  {
    name: "too many selected providers",
    value: () => ({
      ...valid(),
      scope: { mode: "selected", providerKeys: Array.from({ length: 65 }, (_, index) => `addon:${index}`) },
    }),
  },
  {
    name: "a duplicate provider-order key",
    value: () => {
      const policy: any = valid();
      policy.criteria[2] = { kind: "providerOrder", keys: ["addon:a", "addon:a"] };
      return policy;
    },
  },
  {
    name: "an unsupported provider-order source",
    value: () => {
      const policy: any = valid();
      policy.criteria[2] = { kind: "providerOrder", from: "administrator" };
      return policy;
    },
  },
  {
    name: "both provider-order forms",
    value: () => {
      const policy: any = valid();
      policy.criteria[2] = { kind: "providerOrder", keys: [], from: "viewer" };
      return policy;
    },
  },
  {
    name: "an empty source-kind set",
    value: () => {
      const policy: any = valid();
      policy.constraints.sourceKinds = [];
      return policy;
    },
  },
  {
    name: "a duplicate source kind",
    value: () => {
      const policy: any = valid();
      policy.constraints.sourceKinds = ["http", "http"];
      return policy;
    },
  },
  {
    name: "a duplicate criterion kind",
    value: () => {
      const policy: any = valid();
      policy.criteria.push({ kind: "audioTier" });
      return policy;
    },
  },
  {
    name: "too many criteria",
    value: () => {
      const policy: any = valid();
      policy.criteria = Array.from({ length: 9 }, () => ({ kind: "audioTier" }));
      return policy;
    },
  },
  {
    name: "an incomplete provider-class order",
    value: () => {
      const policy: any = valid();
      policy.criteria[0].order = ["local", "remote"];
      return policy;
    },
  },
  {
    name: "a duplicate provider class",
    value: () => {
      const policy: any = valid();
      policy.criteria[0].order = ["local", "local", "remote"];
      return policy;
    },
  },
  {
    name: "an audio criterion with extra fields",
    value: () => {
      const policy: any = valid();
      policy.criteria[1] = { kind: "audioTier", direction: "asc" };
      return policy;
    },
  },
  {
    name: "missing audio preferred language",
    value: () => {
      const policy: any = valid();
      delete policy.constraints.audio.preferred;
      return policy;
    },
  },
  {
    name: "a non-string language code",
    value: () => {
      const policy: any = valid();
      policy.constraints.audio.preferred = { code: 1 };
      return policy;
    },
  },
  {
    name: "an unknown language alias",
    value: () => {
      const policy: any = valid();
      policy.constraints.audio.preferred = { code: "Klingon" };
      return policy;
    },
  },
  {
    name: "an unknown two-letter language code",
    value: () => {
      const policy: any = valid();
      policy.constraints.audio.preferred = { code: "zz" };
      return policy;
    },
  },
  {
    name: "a subtitle preference in an audio field",
    value: () => {
      const policy: any = valid();
      policy.constraints.audio.preferred = { preference: "subtitle" };
      return policy;
    },
  },
  {
    name: "an audio preference in a subtitle field",
    value: () => {
      const policy: any = valid();
      policy.constraints.subtitles.preferred = { preference: "audio" };
      return policy;
    },
  },
  {
    name: "a language ref with both forms",
    value: () => {
      const policy: any = valid();
      policy.constraints.audio.preferred = { code: "en", preference: "audio" };
      return policy;
    },
  },
  {
    name: "subtitles off with a preferred language",
    value: () => {
      const policy: any = valid();
      policy.constraints.subtitles = { mode: "off", preferred: { code: "en" } };
      return policy;
    },
  },
  {
    name: "required subtitles without a preferred language",
    value: () => {
      const policy: any = valid();
      policy.constraints.subtitles = { mode: "required" };
      return policy;
    },
  },
  {
    name: "a subtitle fallback without a preferred language",
    value: () => {
      const policy: any = valid();
      policy.constraints.subtitles = { mode: "optional", fallback: { code: "en" } };
      return policy;
    },
  },
  {
    name: "duplicate audio aliases",
    value: () => {
      const policy: any = valid();
      policy.constraints.audio.preferred = { code: "cze" };
      policy.constraints.audio.fallback = { code: "cs" };
      return policy;
    },
  },
  {
    name: "duplicate subtitle aliases",
    value: () => {
      const policy: any = valid();
      policy.constraints.subtitles.preferred = { code: "ces" };
      policy.constraints.subtitles.fallback = { code: "Czech" };
      return policy;
    },
  },
  {
    name: "duplicate preference refs",
    value: () => {
      const policy: any = valid();
      policy.constraints.subtitles.preferred = { preference: "subtitle" };
      policy.constraints.subtitles.fallback = { preference: "subtitle" };
      return policy;
    },
  },
  {
    name: "an empty bounds object",
    value: () => {
      const policy: any = valid();
      policy.constraints.bytes = {};
      return policy;
    },
  },
  {
    name: "NaN in a bound",
    value: () => {
      const policy: any = valid();
      policy.constraints.bytes = { min: Number.NaN };
      return policy;
    },
  },
  {
    name: "infinite in a bound",
    value: () => {
      const policy: any = valid();
      policy.constraints.durationSeconds = { max: Number.POSITIVE_INFINITY };
      return policy;
    },
  },
  {
    name: "a fractional bound",
    value: () => {
      const policy: any = valid();
      policy.constraints.heightPixels = { min: 479.5 };
      return policy;
    },
  },
  {
    name: "a negative byte bound",
    value: () => {
      const policy: any = valid();
      policy.constraints.bytes = { min: -1 };
      return policy;
    },
  },
  {
    name: "a negative height bound",
    value: () => {
      const policy: any = valid();
      policy.constraints.heightPixels = { min: -480 };
      return policy;
    },
  },
  {
    name: "a zero duration bound",
    value: () => {
      const policy: any = valid();
      policy.constraints.durationSeconds = { max: 0 };
      return policy;
    },
  },
  {
    name: "a zero height bound",
    value: () => {
      const policy: any = valid();
      policy.constraints.heightPixels = { min: 0 };
      return policy;
    },
  },
  {
    name: "an unsafe integer bound",
    value: () => {
      const policy: any = valid();
      policy.constraints.bytes = { max: Number.MAX_SAFE_INTEGER + 1 };
      return policy;
    },
  },
  {
    name: "reversed bounds",
    value: () => {
      const policy: any = valid();
      policy.constraints.bytes = { min: 10, max: 9 };
      return policy;
    },
  },
  {
    name: "an undefined bound endpoint",
    value: () => {
      const policy: any = valid();
      policy.constraints.bytes = { min: undefined };
      return policy;
    },
  },
  {
    name: "an accessor-bearing object",
    value: () => {
      const policy: any = valid();
      Object.defineProperty(policy.scope, "mode", {
        enumerable: true,
        get: () => "allAvailable",
      });
      return policy;
    },
  },
  {
    name: "a sparse array",
    value: () => {
      const policy: any = valid();
      policy.constraints.sourceKinds = new Array(2);
      policy.constraints.sourceKinds[1] = "http";
      return policy;
    },
  },
];

for (const example of invalidCases) {
  test(`rejects ${example.name}`, () => {
    assert.throws(
      () => parseSourcePolicyV1(example.value()),
      (error: unknown) => {
        assert.ok(error instanceof SourcePolicyValidationError);
        assert.equal(error.name, "SourcePolicyValidationError");
        assert.equal(error.message, "Invalid source policy.");
        return true;
      },
    );
  });
}
