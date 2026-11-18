// Preloaded through NODE_OPTIONS: the local backend's child lives on and never answers, the way a
// deadlocked server does. The shell's own process carries no DESKTOP_LOCAL_BACKEND and runs on.
if (process.env.DESKTOP_LOCAL_BACKEND === "1") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
