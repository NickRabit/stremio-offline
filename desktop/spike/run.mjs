import { app, utilityProcess } from "electron";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("./esm-entry.mjs", import.meta.url));

let reported = false;
const report = (line) => {
  if (reported) return;
  reported = true;
  // Exit once the line has left the process: a piped stdout write is asynchronous.
  process.stdout.write(line + "\n", () => app.exit(0));
};

// The timer has to arm before ready. A process that never finishes launching
// would otherwise sit forever, and the spike would print nothing.
setTimeout(() => report("utility-esm: fail timeout"), 10_000);

try {
  await app.whenReady();
  const child = utilityProcess.fork(entry);
  child.on("message", (message) => {
    if (message !== "ready") return;
    report("utility-esm: ok");
  });
  child.on("exit", (code) => {
    report(`utility-esm: fail exit ${code}`);
  });
} catch (error) {
  report("utility-esm: fail " + (error instanceof Error ? error.message : String(error)));
}
