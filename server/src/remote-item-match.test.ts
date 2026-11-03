import assert from "node:assert/strict";
import { test } from "node:test";
import type { LibraryCandidate, LibraryCandidateSource } from "./library-candidates.js";
import { RemoteItemMatcher } from "./remote-item-match.js";
import type { PublicRemoteItem } from "./media-server-types.js";

const item = (id: string, name = id): PublicRemoteItem => ({ id, name, type: "movie", providerIds: {} });

const source = () => {
  const calls: string[] = [];
  let hold: Promise<void> | undefined;
  const failures = new Set<string>();
  const candidates: LibraryCandidateSource & {
    calls: string[];
    failures: Set<string>;
    setHold(value: Promise<void> | undefined): void;
  } = {
    calls,
    failures,
    setHold: (value) => { hold = value; },
    searchLibraryCandidates: async (query): Promise<LibraryCandidate[]> => {
      calls.push(query);
      if (failures.has(query)) throw new Error("provider failed");
      await hold;
      return [];
    },
    resolveSelected: async (candidate) => candidate.item,
    galleryOf: async () => [],
  };
  return candidates;
};

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a failed remote match releases its slot and is cached as a failure", async () => {
  const candidates = source();
  candidates.failures.add("Failed");
  const matcher = new RemoteItemMatcher(candidates, { timeoutMs: 1_000 });

  await matcher.enrich("lib", item("failed", "Failed"), "en");
  await matcher.enrich("lib", item("ok", "Okay"), "en");
  await matcher.enrich("lib", item("failed", "Failed"), "en");

  assert.deepEqual(candidates.calls, ["Failed", "Okay"]);
});

test("the remote match queue is bounded and a queue refusal is not cached", async () => {
  const candidates = source();
  let release!: () => void;
  candidates.setHold(new Promise<void>((resolve) => { release = resolve; }));
  const matcher = new RemoteItemMatcher(candidates, { timeoutMs: 1_000, maxQueuedSearches: 1 });

  const first = matcher.enrich("lib", item("a", "A"), "en");
  const second = matcher.enrich("lib", item("b", "B"), "en");
  await tick();
  const third = matcher.enrich("lib", item("c", "C"), "en");
  const refused = await matcher.enrich("lib", item("d", "D"), "en");

  assert.deepEqual(refused.providerIds, {});
  assert.deepEqual(candidates.calls, ["A", "B"]);
  release();
  await Promise.all([first, second, third]);
  candidates.setHold(undefined);
  await matcher.enrich("lib", item("d", "D"), "en");
  assert.deepEqual(candidates.calls, ["A", "B", "C", "D"]);
});
