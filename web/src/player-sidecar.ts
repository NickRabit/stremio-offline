export const SIDECAR_POLL_MS = 250;
export const SIDECAR_SETTLED_POLL_MS = 5_000;
export const SIDECAR_REQUEST_MS = 15_000;
/** How close the picture may get to the last cue before the track is read again. */
export const SIDECAR_REFRESH_LEAD_S = 45;

export interface SidecarState { complete: boolean; pass: number; coverage: number }

/** Safari gained AbortSignal.any only in 17.4, so a per-request timeout that also
 *  follows the caller's cancellation is wired by hand. */
function requestSignal(signal: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  signal.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    settle: () => { clearTimeout(timer); signal.removeEventListener("abort", abort); },
  };
}

/** The server reads a film's subtitles as fast as the source allows, which is faster
 *  than the film plays but not instant. The track is attached once the cues are ahead
 *  of the picture, read again before the picture catches up with them, and a last time
 *  when the reader has the rest. Each pass is a new attachment, so they stay rare. */
export async function watchSidecar(
  url: string,
  signal: AbortSignal,
  playhead: () => number,
  onState: (state: SidecarState) => void,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  /** Answers false when the caller did not take the new revision, and the watcher polls on. */
  onRevision?: (url: string) => boolean | void,
): Promise<void> {
  let pass = -1;
  let attached = -Infinity;
  while (!signal.aborted) {
    const request = requestSignal(signal, SIDECAR_REQUEST_MS);
    const requestedAt = Math.max(0, playhead());
    const pollUrl = `${url}${url.includes("?") ? "&" : "?"}position=${requestedAt.toFixed(3)}`;
    const response = await fetcher(pollUrl, { signal: request.signal }).catch(() => undefined);
    request.settle();
    if (signal.aborted) return;
    if (response?.status === 410) {
      const current = await response.json().catch(() => undefined) as { sidecarUrl?: unknown } | undefined;
      if (signal.aborted) return;
      // Adopted: this watcher is done. Not adopted (a reposition is on its way) or an answer
      // without a URL: keep polling as after a 404.
      if (typeof current?.sidecarUrl === "string" && onRevision?.(current.sidecarUrl) !== false) return;
    } else if (response) {
      // The element fetches the track itself; this copy of the body is dead weight.
      void response.body?.cancel().catch(() => undefined);
    }
    if (response?.ok) {
      const complete = response.headers.get("x-sidecar-complete") === "1";
      const coverage = complete ? Infinity : Number(response.headers.get("x-sidecar-coverage") ?? "");
      const position = Math.max(0, playhead());
      const attachedShort = attached < position + SIDECAR_REFRESH_LEAD_S;
      const newWindow = coverage > attached
        && (position >= attached || (attachedShort && coverage >= position + SIDECAR_REFRESH_LEAD_S));
      if (pass < 0 || complete || newWindow) {
        pass += 1;
        attached = Number.isFinite(coverage) ? coverage : Infinity;
        onState({ complete, pass, coverage });
      }
      if (complete) return;
    }
    const needsCloseWatch = pass < 0 || attached < Math.max(0, playhead()) + SIDECAR_REFRESH_LEAD_S;
    await delay(needsCloseWatch ? SIDECAR_POLL_MS : SIDECAR_SETTLED_POLL_MS);
  }
}
