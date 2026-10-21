import type Hls from "hls.js";

// hls.js is a third of the interface's script and only the player needs it, so it is its own
// chunk: fetched when a player opens, long before the server has a stream ready to attach.
let loaded: typeof Hls | undefined;
let loading: Promise<typeof Hls> | undefined;

export const hlsIfLoaded = () => loaded;

export function loadHls(): Promise<typeof Hls> {
  loading ??= import("hls.js").then(
    (module) => (loaded = module.default),
    (error: unknown) => { loading = undefined; throw error; },
  );
  return loading;
}
