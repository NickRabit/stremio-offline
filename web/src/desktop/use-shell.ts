import { useEffect, useState } from "react";
import type { ShellBridge, ShellState } from "./bridge";

/** The shell's state, as pushed by the main process. Null until the first answer. */
export function useShellState(bridge: ShellBridge): ShellState | null {
  const [state, setState] = useState<ShellState | null>(null);
  useEffect(() => {
    let live = true;
    const unsubscribe = bridge.onState((next) => { if (live) setState(next); });
    void bridge.getState().then((next) => { if (live) setState((current) => current ?? next); });
    return () => { live = false; unsubscribe(); };
  }, [bridge]);
  return state;
}
