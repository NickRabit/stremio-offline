#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const children = new Set();
let stopping = false;

const fail = (message) => {
  console.error(message);
  process.exitCode = 1;
};

const usage = `Usage: node scripts/test-stress.mjs <test-file> [--pattern "<test name>"] [--runs 30] [--parallel 6] [--load 4]`;

const positiveInteger = (name, value) => {
  if (!/^[1-9]\d*$/.test(value ?? "")) throw new Error(`${name} needs a positive integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${name} is too large`);
  return number;
};

const parseArgs = (args) => {
  let file;
  let pattern;
  let runs = 30;
  let parallel = 6;
  let load = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--pattern" || arg === "--runs" || arg === "--parallel" || arg === "--load") {
      const value = args[++index];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === "--pattern") pattern = value;
      else if (arg === "--runs") runs = positiveInteger(arg, value);
      else if (arg === "--parallel") parallel = positiveInteger(arg, value);
      else load = positiveInteger(arg, value);
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else if (file === undefined) {
      file = arg;
    } else {
      throw new Error(`only one test file is accepted: ${arg}`);
    }
  }
  if (!file) throw new Error("a test file is required");
  return { file: path.resolve(process.cwd(), file), pattern, runs, parallel, load };
};

const workspaceFor = async (file) => {
  let directory = path.dirname(file);
  for (;;) {
    try {
      await access(path.join(directory, "package.json"));
      return directory;
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error(`no workspace package.json owns ${file}`);
      directory = parent;
    }
  }
};

// A run is `npx` -> `tsx` -> `node`, so killing `npx` alone leaves the others behind: each run is started in
// its own process group (POSIX) or killed with its tree (Windows).
const killTree = (child) => {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
};

const stopChildren = () => {
  for (const child of children) killTree(child);
};

const startLoad = () => {
  const child = spawn(process.execPath, [
    "-e",
    "const burn = () => { const until = Date.now() + 20; while (Date.now() < until); setTimeout(burn, 0); }; burn();",
  ], { stdio: "ignore" });
  child.unref();
  if (child.pid) {
    try {
      os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      // The load still runs when the platform does not allow changing its priority.
    }
  }
  return child;
};

const runCommand = (command, args, options) => new Promise((resolve) => {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  children.add(child);
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.once("error", (error) => {
    children.delete(child);
    resolve({ code: 1, output: `${output}${error.message}` });
  });
  child.once("close", (code, signal) => {
    children.delete(child);
    resolve({ code: code ?? (signal ? 1 : 0), output });
  });
});

const firstFailure = (output) => {
  const lines = output.split(/\r?\n/);
  const at = lines.findIndex((line) => /^(?:not ok \d+ -|✖)\s+/.test(line));
  if (at < 0) return { test: "test process", message: output.trim().split(/\r?\n/).at(-1) || "no output" };
  const test = lines[at].replace(/^(?:not ok \d+ -|✖)\s+/, "").replace(/\s+\(\d+(?:\.\d+)?ms\)$/, "").trim();
  const evidence = lines.slice(at + 1).find((line) =>
    /(?:AssertionError|ERR_ASSERTION|Error:|timeout:|Expected values|actual:|expected:)/i.test(line)
  );
  const message = evidence?.trim() ?? lines.slice(at + 1).find((line) => line.trim() && line.trim() !== "...")?.trim() ?? "no assertion message";
  return { test, message };
};

const main = async () => {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    await access(options.file);
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}\n${usage}`);
    return;
  }

  const workspace = await workspaceFor(options.file);
  const relativeFile = path.relative(workspace, options.file);
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const commandArgs = ["tsx", "--test", "--test-timeout=120000"];
  if (options.pattern !== undefined) commandArgs.push(`--test-name-pattern=${options.pattern}`);
  commandArgs.push(relativeFile);

  const loadChildren = Array.from({ length: options.load }, startLoad);
  for (const child of loadChildren) children.add(child);

  const results = new Array(options.runs);
  let next = 0;
  const worker = async () => {
    while (!stopping) {
      const index = next++;
      if (index >= options.runs) return;
      const result = await runCommand(npx, commandArgs, { cwd: workspace });
      if (stopping) return; // a run that was killed by Ctrl-C is not a failure of the test
      const passed = result.code === 0;
      results[index] = { passed, ...(passed ? {} : firstFailure(result.output)) };
      console.log(`run ${index + 1}: ${passed ? "pass" : "fail"}`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(options.parallel, options.runs) }, worker));
  stopChildren();

  if (stopping) {
    console.log("\ninterrupted");
    return;
  }

  const completed = results.filter(Boolean);
  const failures = completed.filter((result) => !result.passed);
  if (completed.length) {
    console.log(`\n${completed.length} run${completed.length === 1 ? "" : "s"}, ${failures.length} failure${failures.length === 1 ? "" : "s"}`);
    for (const [index, failure] of results.entries()) {
      if (failure && !failure.passed) console.log(`run ${index + 1}: ${failure.test}: ${failure.message}`);
    }
  }
  if (failures.length || completed.length !== options.runs) process.exitCode = 1;
};

process.once("SIGINT", () => {
  stopping = true;
  stopChildren();
  process.exitCode = 130;
});
process.once("SIGTERM", () => {
  stopping = true;
  stopChildren();
  process.exitCode = 143;
});
process.once("exit", stopChildren);
process.once("uncaughtException", (error) => {
  stopChildren();
  console.error(error);
  process.exit(1);
});
process.once("unhandledRejection", (error) => {
  stopChildren();
  console.error(error);
  process.exit(1);
});

await main().catch((error) => {
  stopChildren();
  console.error(error);
  process.exitCode = 1;
});
