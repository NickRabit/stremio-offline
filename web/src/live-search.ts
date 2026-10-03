export const LIVE_SEARCH_DELAY_MS = 500;
export const LIVE_SEARCH_MIN_LENGTH = 3;

/** Code points, not UTF-16 units: "ž" and an emoji each count as one. */
export function codePointLength(text: string): number {
  return [...text].length;
}

export type LiveSearchState = "idle" | "pending" | "tooShort";

export interface LiveSearch {
  /** Call on every draft change with the currently committed query. */
  update(draft: string, committed: string): void;
  compositionStart(): void;
  /** Call with the draft as it stands after composition. */
  compositionEnd(draft: string, committed: string): void;
  /** Drops a pending commit (view left, explicit submit, unmount). */
  cancel(): void;
  state(): LiveSearchState;
}

export function createLiveSearch(options: {
  onCommit: (query: string) => void;
  onState?: (state: LiveSearchState) => void;
  delayMs?: number;
  minLength?: number;
}): LiveSearch {
  const delayMs = options.delayMs ?? LIVE_SEARCH_DELAY_MS;
  const minLength = options.minLength ?? LIVE_SEARCH_MIN_LENGTH;
  let state: LiveSearchState = "idle";
  let composing = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const setState = (next: LiveSearchState) => {
    if (next === state) return;
    state = next;
    options.onState?.(state);
  };
  const clearTimer = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };

  const update = (draft: string, committed: string) => {
    clearTimer();
    if (composing) return;
    const query = draft.trim();
    if (query === committed) { setState("idle"); return; }
    if (query === "") { options.onCommit(""); setState("idle"); return; }
    if (codePointLength(query) < minLength) { setState("tooShort"); return; }
    setState("pending");
    timer = setTimeout(() => { timer = null; options.onCommit(query); setState("idle"); }, delayMs);
  };

  return {
    update,
    compositionStart: () => { composing = true; clearTimer(); },
    compositionEnd: (draft, committed) => { composing = false; update(draft, committed); },
    cancel: () => { clearTimer(); setState("idle"); },
    state: () => state,
  };
}
