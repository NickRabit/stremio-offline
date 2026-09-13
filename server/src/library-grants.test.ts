import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { envGrants, grantingRoot, insideGrant, mergeGrants, parseRootList } from "./library-grants.js";
import type { RootGrant } from "./libraries.js";

const grant = (over: Partial<RootGrant> = {}): RootGrant => ({
  path: "/media", source: "env", grantedAt: "2026-01-01T00:00:00.000Z", ...over,
});

test("the root list is comma separated, deduplicated and keeps only absolute paths", () => {
  assert.deepEqual(parseRootList(undefined, "/downloads"), ["/downloads"]);
  assert.deepEqual(parseRootList("", "/downloads"), ["/downloads"]);
  assert.deepEqual(parseRootList(" , ", "/downloads"), ["/downloads"]);
  assert.deepEqual(parseRootList("/media, /archive/", "/downloads"), ["/media", "/archive"]);
  assert.deepEqual(parseRootList("/media,/media", "/downloads"), ["/media"]);
  assert.deepEqual(parseRootList("media,/archive", "/downloads"), ["/archive"], "a relative entry would depend on the working directory");
});

test("env grants carry their source and the boot time", () => {
  assert.deepEqual(envGrants("/media", "/downloads", "2026-09-13T00:00:00.000Z"), [
    { path: "/media", source: "env", grantedAt: "2026-09-13T00:00:00.000Z" },
  ]);
});

test("a user grant is dropped where the operator already granted the same path", () => {
  const merged = mergeGrants(
    [grant({ path: "/media/" })],
    [grant({ path: "/media", source: "user" }), grant({ path: "/archive", source: "user" })],
  );
  assert.deepEqual(merged.map((entry) => [entry.path, entry.source]), [["/media/", "env"], ["/archive", "user"]]);
  assert.equal(merged.length, 2, "the same path is granted once");
});

test("only a path inside a granted root is granted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "grant-"));
  const outside = await mkdtemp(path.join(tmpdir(), "outside-"));
  await mkdir(path.join(root, "Films"));
  await symlink(outside, path.join(root, "link"));
  const grants = [grant({ path: root })];

  assert.equal(await insideGrant(grants, path.join(root, "Films")), true);
  assert.equal(await insideGrant(grants, path.join(root, "New", "Deeper")), true, "a path that does not exist yet is still granted");
  assert.equal(await insideGrant(grants, root), true);
  assert.equal(await insideGrant(grants, outside), false);
  assert.equal(await insideGrant(grants, path.join(root, "..", path.basename(outside))), false);
  assert.equal(await insideGrant(grants, path.join(root, "link", "secret")), false, "a symlink out of the grant grants nothing");
  assert.equal((await grantingRoot(grants, path.join(root, "Films")))?.source, "env");
  assert.equal(await insideGrant([grant({ path: path.join(root, "gone") })], path.join(root, "gone", "x")), false, "a grant that does not exist grants nothing");

  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});
