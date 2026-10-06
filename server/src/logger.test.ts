import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clearLog, currentLevel, flushLog, initLogger, log, pruneLog, readLog, setLevel } from "./logger.js";

const withLogger = async (env: Record<string, string | undefined>, body: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-logger-"));
  const previous = { ...process.env };
  try {
    Object.assign(process.env, { LOG_STDOUT: "0", LOG_LEVEL: undefined, LOG_MAX_BYTES: undefined, ...env });
    await initLogger(directory);
    await body(directory);
  } finally {
    process.env = previous;
    await rm(directory, { recursive: true, force: true });
  }
};

const contents = async (directory: string) => {
  await flushLog();
  return readFile(path.join(directory, "app.log"), "utf8").catch(() => "");
};

test("entries below the configured level are dropped", async () => {
  await withLogger({ LOG_LEVEL: "WARN" }, async (directory) => {
    log("DEBUG", "debug entry"); log("INFO", "info entry"); log("WARN", "warn entry"); log("ERROR", "error entry");
    const text = await contents(directory);
    assert.equal(text.includes("debug entry"), false);
    assert.equal(text.includes("info entry"), false);
    assert.match(text, /WARN warn entry/);
    assert.match(text, /ERROR error entry/);
  });
});

test("an unknown LOG_LEVEL falls back to INFO", async () => {
  await withLogger({ LOG_LEVEL: "chatty" }, async (directory) => {
    log("DEBUG", "debug entry"); log("INFO", "info entry");
    const text = await contents(directory);
    assert.equal(text.includes("debug entry"), false);
    assert.match(text, /INFO info entry/);
  });
});

test("addresses lose their query string and sensitive keys are masked", async () => {
  await withLogger({}, async (directory) => {
    log("INFO", "source connected", {
      url: "https://cdn.example.com/movie/file.mkv?token=abc123&exp=99",
      reason: "ffmpeg failed on http://user:pw@cdn.example.com/a/b.m3u8?key=secret",
      accessToken: "abc123",
      airplay: "receiver-secret",
      playlist: 'URI="segment.m4s?airplay=receiver-secret"',
      nested: { cookie: "session=1", host: "cdn.example.com" },
    });
    const text = await contents(directory);
    assert.equal(text.includes("abc123"), false);
    assert.equal(text.includes("receiver-secret"), false);
    assert.equal(text.includes("token="), false);
    assert.equal(text.includes("session=1"), false);
    assert.match(text, /https:\/\/cdn\.example\.com/);
    assert.match(text, /"accessToken":"\*\*\*"/);
    assert.match(text, /"host":"cdn\.example\.com"/);
  });
});

test("a message carries the same redaction as a context value", async () => {
  await withLogger({}, async (directory) => {
    const url = "http://user:pw@cdn.example/a.m3u8?token=SECRET";
    log("INFO", `player failed on ${url}`);
    log("INFO", "player failed", { url });
    const text = await contents(directory);
    assert.equal(text.includes("SECRET"), false);
    assert.equal(text.includes("token="), false);
    assert.equal(text.includes("user:pw"), false);
    assert.match(text, /player failed on http:\/\/cdn\.example\/…/);
    assert.match(text, /"url":"http:\/\/cdn\.example\/…"/, "the context value is shortened the same way");
  });
});

test("a message cannot carry a newline into the log", async () => {
  await withLogger({}, async (directory) => {
    log("INFO", "first line\n2026-01-01T00:00:00.000Z INFO a forged line");
    const lines = (await contents(directory)).split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "the forged line never becomes a line of its own");
    assert.match(lines[0]!, /first line .*a forged line/);
  });
});

test("the file rotates once it passes the size cap and history stays readable", async () => {
  await withLogger({ LOG_MAX_BYTES: "65536" }, async (directory) => {
    // Roughly 450 bytes per line, so a 64 KB cap rotates once somewhere past entry 140.
    for (let index = 0; index < 200; index += 1) log("INFO", `entry ${index}`, { filler: "x".repeat(400) });
    await flushLog();
    const current = await readFile(path.join(directory, "app.log"), "utf8");
    const rotated = await readFile(path.join(directory, "app.log.1"), "utf8");
    assert.ok(Buffer.byteLength(current) <= 65536);
    assert.ok(rotated.includes("entry 0"));
    assert.match(current, /entry 199/);
    assert.match(await readLog({}), /entry 0 [\s\S]*entry 199 /);
  });
});

test("readLog filters by level and returns only the requested tail", async () => {
  await withLogger({}, async () => {
    log("INFO", "first"); log("WARN", "second"); log("ERROR", "third"); log("INFO", "fourth");
    await flushLog();
    const warnings = await readLog({ level: "WARN" });
    assert.match(warnings, /second/); assert.match(warnings, /third/);
    assert.equal(warnings.includes("first"), false);
    const tail = await readLog({ tail: 1 });
    assert.match(tail, /fourth/);
    assert.equal(tail.includes("third"), false);
  });
});

test("readLog narrows down by time window and by text", async () => {
  await withLogger({}, async (directory) => {
    const old = new Date(Date.now() - 48 * 3600_000).toISOString();
    log("WARN", "fresh entry", { addon: "Cinemeta" });
    await flushLog();
    const file = path.join(directory, "app.log");
    await writeFile(file, `${old} WARN stale entry {"addon":"Torrentio"}\n${await readFile(file, "utf8")}`);
    const recent = await readLog({ hours: 24 });
    assert.match(recent, /fresh entry/);
    assert.equal(recent.includes("stale entry"), false);
    const found = await readLog({ search: "torrentio" });
    assert.match(found, /stale entry/);
    assert.equal(found.includes("fresh entry"), false);
    assert.equal(await readLog({ search: "nothing matches this" }), "");
  });
});

test("entries older than the retention window are pruned away", async () => {
  await withLogger({}, async (directory) => {
    const file = path.join(directory, "app.log");
    const old = new Date(Date.now() - 9 * 24 * 3600_000).toISOString();
    log("INFO", "recent entry");
    await flushLog();
    await writeFile(file, `${old} INFO ancient entry\n${await readFile(file, "utf8")}`);
    assert.equal(await pruneLog(7), 1);
    const text = await readFile(file, "utf8");
    assert.equal(text.includes("ancient entry"), false);
    assert.match(text, /recent entry/);
    // A write after the cleanup has to continue, not overwrite what is left.
    log("INFO", "after prune");
    await flushLog();
    assert.match(await readFile(file, "utf8"), /recent entry[\s\S]*after prune/);
  });
});

test("clearing removes the log and the rotated generation", async () => {
  await withLogger({ LOG_MAX_BYTES: "65536" }, async (directory) => {
    for (let index = 0; index < 200; index += 1) log("INFO", `entry ${index}`, { filler: "x".repeat(400) });
    await flushLog();
    await clearLog();
    assert.equal(await readFile(path.join(directory, "app.log"), "utf8"), "");
    assert.equal(await readFile(path.join(directory, "app.log.1"), "utf8").then(() => true, () => false), false);
    log("INFO", "after clearing");
    await flushLog();
    assert.match(await readFile(path.join(directory, "app.log"), "utf8"), /after clearing/);
  });
});

test("an empty log reports that instead of failing", async () => {
  await withLogger({}, async (directory) => {
    await writeFile(path.join(directory, "app.log"), "");
    assert.match(await readLog({}), /no entries/);
  });
});

test("what the server records is a setting, not only a container variable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "log-level-"));
  const original = process.env.LOG_LEVEL;
  try {
    process.env.LOG_LEVEL = "INFO";
    await initLogger(directory);
    assert.equal(currentLevel(), "INFO");
    log("DEBUG", "detail nobody asked for");
    await flushLog();
    assert.doesNotMatch(await readLog(), /detail nobody asked for/, "below the level, so it is never written");

    // Asking for detail in the interface has to reach the writer, or the log view has nothing to show.
    setLevel("DEBUG");
    assert.equal(currentLevel(), "DEBUG");
    log("DEBUG", "detail that was asked for");
    await flushLog();
    assert.match(await readLog(), /detail that was asked for/);
  } finally {
    if (original === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = original;
    await rm(directory, { recursive: true, force: true });
  }
});
