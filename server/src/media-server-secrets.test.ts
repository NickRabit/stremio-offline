import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, chown, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MediaServerSecrets, type MediaServerSecretBinding } from "./media-server-secrets.js";
import { MEDIA_SECRET_REF } from "./media-server-types.js";

const CONNECTION = "mconn_11111111111111111111111111111111";
const binding = (over: Partial<MediaServerSecretBinding> = {}): MediaServerSecretBinding => ({
  connectionId: CONNECTION,
  provider: "jellyfin",
  serverId: "server-1",
  accountId: "user-1",
  ...over,
});

const isWin = process.platform === "win32";
const isRoot = !isWin && typeof process.getuid === "function" && process.getuid() === 0;

interface Fixture {
  root: string;
  keyFile: string;
  directory: string;
  key: Buffer;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "media-secrets-"));
  const key = randomBytes(32);
  const keyFile = path.join(root, "secret.key");
  await writeFile(keyFile, key, { mode: 0o600 });
  const directory = path.join(root, "vault");
  return { root, keyFile, directory, key };
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const created = await fixture();
  try { await run(created); }
  finally { await rm(created.root, { recursive: true, force: true }); }
}

test("keyConfigured only reports whether a path was supplied, never the path", async () => {
  await withFixture(async ({ directory, keyFile }) => {
    assert.equal(new MediaServerSecrets(directory, keyFile).keyConfigured(), true);
    assert.equal(new MediaServerSecrets(directory, undefined).keyConfigured(), false);
  });
});

test("references lists the handles the vault holds, ignoring its own temp files and junk", async () => {
  await withFixture(async ({ directory, keyFile }) => {
    const vault = new MediaServerSecrets(directory, keyFile);
    assert.deepEqual(await vault.references(), [], "a missing directory is empty, not an error");
    const first = await vault.put(binding(), "one");
    const second = await vault.put(binding(), "two");
    await writeFile(path.join(directory, "not-a-handle"), "junk");
    await writeFile(path.join(directory, `.${first}.deadbeef.tmp`), "temp");
    const listed = await vault.references();
    assert.deepEqual(listed, [first, second].sort());
  });
});

test("references fails closed on an unsafe vault directory", async () => {
  if (isWin) return;
  await withFixture(async ({ root, directory, keyFile }) => {
    const vault = new MediaServerSecrets(directory, keyFile);
    await vault.put(binding(), "one");
    await chmod(directory, 0o755);
    const insecure = new MediaServerSecrets(directory, keyFile);
    await assert.rejects(insecure.references(), { code: "secret-unavailable" });
    await chmod(directory, 0o700);
    assert.equal((await vault.references()).length, 1);
    void root;
  });
});

test("a token round-trips and a 8192-byte token is accepted", async () => {
  await withFixture(async ({ directory, keyFile }) => {
    const vault = new MediaServerSecrets(directory, keyFile);
    const ref = await vault.put(binding(), "short-token");
    assert.match(ref, MEDIA_SECRET_REF);
    assert.equal(await vault.get(binding(), ref), "short-token");
    const big = "A".repeat(8192);
    const bigRef = await vault.put(binding(), big);
    assert.equal(await vault.get(binding(), bigRef), big);
  });
});

test("the vault directory is owner-only and the stored file is private", async () => {
  await withFixture(async ({ directory, keyFile }) => {
    if (isWin) return;
    const vault = new MediaServerSecrets(directory, keyFile);
    const ref = await vault.put(binding(), "token");
    const { stat } = await import("node:fs/promises");
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(directory, ref))).mode & 0o777, 0o600);
  });
});

test("a different key fails closed instead of returning the token", async () => {
  await withFixture(async ({ root, directory, keyFile }) => {
    const vault = new MediaServerSecrets(directory, keyFile);
    const ref = await vault.put(binding(), "token");
    const otherKey = path.join(root, "other.key");
    await writeFile(otherKey, randomBytes(32), { mode: 0o600 });
    await assert.rejects(new MediaServerSecrets(directory, otherKey).get(binding(), ref), { code: "secret-unavailable" });
  });
});

test("a swapped binding or a swapped file fails to decrypt", async () => {
  await withFixture(async ({ directory, keyFile }) => {
    const vault = new MediaServerSecrets(directory, keyFile);
    const ref = await vault.put(binding(), "token");
    await assert.rejects(vault.get(binding({ accountId: "other" }), ref), { code: "secret-unavailable" });
    await assert.rejects(vault.get(binding({ connectionId: "mconn_" + "2".repeat(32) }), ref), { code: "secret-unavailable" });
    await assert.rejects(vault.get(binding(), "msecret_" + "f".repeat(32)), { code: "secret-unavailable" });

    const second = await vault.put(binding({ accountId: "user-2" }), "second");
    const first = await readFile(path.join(directory, ref));
    const other = await readFile(path.join(directory, second));
    await writeFile(path.join(directory, ref), other);
    await writeFile(path.join(directory, second), first);
    await assert.rejects(vault.get(binding(), ref), { code: "secret-unavailable" });
    await assert.rejects(vault.get(binding({ accountId: "user-2" }), second), { code: "secret-unavailable" });
  });
});

test("an unsafe key file is refused: group-readable, symlink, wrong size, missing", async () => {
  await withFixture(async ({ root, directory, keyFile }) => {
    if (!isWin) {
      const loose = path.join(root, "loose.key");
      await writeFile(loose, randomBytes(32), { mode: 0o644 });
      await chmod(loose, 0o644);
      await assert.rejects(new MediaServerSecrets(directory, loose).put(binding(), "t"), { code: "secret-key-unavailable" });
    }
    const short = path.join(root, "short.key");
    await writeFile(short, randomBytes(16), { mode: 0o600 });
    await assert.rejects(new MediaServerSecrets(directory, short).put(binding(), "t"), { code: "secret-key-unavailable" });
    await assert.rejects(new MediaServerSecrets(directory, path.join(root, "absent.key")).put(binding(), "t"), { code: "secret-key-unavailable" });
    await assert.rejects(new MediaServerSecrets(directory, undefined).put(binding(), "t"), { code: "secret-key-unavailable" });
    if (!isWin) {
      const link = path.join(root, "link.key");
      await symlink(keyFile, link);
      await assert.rejects(new MediaServerSecrets(directory, link).put(binding(), "t"), { code: "secret-key-unavailable" });
    }
  });
});

test("a symlinked or corrupt envelope is refused", async () => {
  await withFixture(async ({ root, directory, keyFile }) => {
    const vault = new MediaServerSecrets(directory, keyFile);
    const ref = await vault.put(binding(), "token");
    await writeFile(path.join(directory, ref), "not json");
    await assert.rejects(vault.get(binding(), ref), { code: "secret-unavailable" });
    if (!isWin) {
      await rm(path.join(directory, ref));
      const target = path.join(root, "elsewhere");
      await writeFile(target, "x");
      await symlink(target, path.join(directory, ref));
      await assert.rejects(vault.get(binding(), ref), { code: "secret-unavailable" });
    }
  });
});

test("an owner-insecure vault directory is refused", async () => {
  await withFixture(async ({ directory, keyFile }) => {
    if (isWin) return;
    const vault = new MediaServerSecrets(directory, keyFile);
    await vault.put(binding(), "token");
    await chmod(directory, 0o755);
    await assert.rejects(vault.put(binding(), "token"), { code: "secret-unavailable" });
  });
});

test("a reference is validated before any filesystem access", async () => {
  await withFixture(async ({ directory, keyFile }) => {
    const vault = new MediaServerSecrets(directory, keyFile);
    for (const bad of ["", "../escape", "msecret_short", "msecret_" + "z".repeat(32)]) {
      await assert.rejects(vault.get(binding(), bad), { code: "invalid-input" });
      await assert.rejects(vault.remove(bad), { code: "invalid-input" });
    }
  });
});

test("tokens survive a restart and a changed key fails afterwards", async () => {
  await withFixture(async ({ root, directory, keyFile }) => {
    const ref = await new MediaServerSecrets(directory, keyFile).put(binding(), "token");
    assert.equal(await new MediaServerSecrets(directory, keyFile).get(binding(), ref), "token");
    const replacement = path.join(root, "replacement.key");
    await writeFile(replacement, randomBytes(32), { mode: 0o600 });
    await assert.rejects(new MediaServerSecrets(directory, replacement).get(binding(), ref), { code: "secret-unavailable" });
  });
});

test("remove is idempotent and needs no key", async () => {
  await withFixture(async ({ directory, keyFile }) => {
    const ref = await new MediaServerSecrets(directory, keyFile).put(binding(), "token");
    const keyless = new MediaServerSecrets(directory, undefined);
    await keyless.remove(ref);
    await keyless.remove(ref);
    await assert.rejects(new MediaServerSecrets(directory, keyFile).get(binding(), ref), { code: "secret-unavailable" });
  });
});

test("concurrent writes serialize and all land", async () => {
  await withFixture(async ({ directory, keyFile }) => {
    const vault = new MediaServerSecrets(directory, keyFile);
    const refs = await Promise.all(Array.from({ length: 6 }, (_, index) => vault.put(binding(), `token-${index}`)));
    const values = await Promise.all(refs.map((ref, index) => vault.get(binding(), ref).then((value) => [value, index] as const)));
    for (const [value, index] of values) assert.equal(value, `token-${index}`);
    assert.equal(new Set(refs).size, refs.length);
  });
});

test("a failed rename leaves no temporary file behind", async () => {
  await withFixture(async ({ directory, keyFile }) => {
    const vault = new MediaServerSecrets(directory, keyFile, { rename: async () => { throw new Error("rename refused"); } });
    await assert.rejects(vault.put(binding(), "token"), { code: "secret-unavailable" });
    const entries = await readdir(directory);
    assert.deepEqual(entries.filter((entry) => entry.endsWith(".tmp")), []);
  });
});

test("an injected key still cannot pass a token the transport would refuse", async () => {
  await withFixture(async ({ directory, keyFile }) => {
    const vault = new MediaServerSecrets(directory, keyFile);
    await assert.rejects(vault.put(binding(), 'bad"token'), { code: "invalid-input" });
  });
});

test("an opened secret whose mode or owner is wrong is refused", async () => {
  await withFixture(async ({ directory, keyFile }) => {
    if (isWin) return;
    const vault = new MediaServerSecrets(directory, keyFile);
    const ref = await vault.put(binding(), "token");
    const target = path.join(directory, ref);
    await chmod(target, 0o644);
    await assert.rejects(vault.get(binding(), ref), { code: "secret-unavailable" });
    if (isRoot) {
      await chmod(target, 0o600);
      await chown(target, 1, 1);
      await assert.rejects(vault.get(binding(), ref), { code: "secret-unavailable" });
    }
  });
});

test("a vault directory or key owned by another user is refused where root can chown", async () => {
  await withFixture(async ({ directory, keyFile }) => {
    if (!isRoot) return;
    const vault = new MediaServerSecrets(directory, keyFile);
    await vault.put(binding(), "token");
    await chown(directory, 1, 1);
    await assert.rejects(vault.put(binding(), "token"), { code: "secret-unavailable" });
    await chown(directory, 0, 0);
    await chown(keyFile, 1, 1);
    await assert.rejects(vault.put(binding(), "token"), { code: "secret-key-unavailable" });
    await chown(keyFile, 0, 0);
  });
});

test("remove refuses a symlinked vault directory and stays idempotent otherwise", async () => {
  await withFixture(async ({ root, directory, keyFile }) => {
    if (isWin) return;
    const real = path.join(root, "real-vault");
    await mkdir(real, { mode: 0o700 });
    await symlink(real, directory);
    await assert.rejects(new MediaServerSecrets(directory, keyFile).remove("msecret_" + "a".repeat(32)), { code: "secret-unavailable" });
    const missing = new MediaServerSecrets(path.join(root, "absent"), undefined);
    await missing.remove("msecret_" + "b".repeat(32));
  });
});

test("a FIFO is refused before it can block the reader", async () => {
  await withFixture(async ({ root, directory, keyFile }) => {
    if (isWin) return;
    await mkdir(directory, { mode: 0o700 });
    const fifo = path.join(directory, "msecret_" + "c".repeat(32));
    execFileSync("mkfifo", [fifo]);
    await assert.rejects(new MediaServerSecrets(directory, keyFile).get(binding(), "msecret_" + "c".repeat(32)), { code: "secret-unavailable" });
    const fifoKey = path.join(root, "fifo.key");
    execFileSync("mkfifo", [fifoKey]);
    await assert.rejects(new MediaServerSecrets(directory, fifoKey).put(binding(), "t"), { code: "secret-key-unavailable" });
  });
});

test("an oversized stored envelope is refused", async () => {
  await withFixture(async ({ directory, keyFile }) => {
    const vault = new MediaServerSecrets(directory, keyFile);
    const ref = await vault.put(binding(), "token");
    await writeFile(path.join(directory, ref), Buffer.alloc(32 * 1024 + 1), { mode: 0o600 });
    await assert.rejects(vault.get(binding(), ref), { code: "secret-unavailable" });
  });
});

test("a secret binding cannot coerce an object into a connection handle", async () => {
  await withFixture(async ({ directory, keyFile }) => {
    const vault = new MediaServerSecrets(directory, keyFile);
    const forged = binding({ connectionId: { toString: () => CONNECTION } as unknown as string });
    await assert.rejects(vault.put(forged, "token"), { code: "invalid-input" });
  });
});
