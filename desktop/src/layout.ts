export interface Bounds { x: number; y: number; width: number; height: number }

export type PageMode = "shell" | "remote" | "fullscreen";

/** The toast overlay: its own size, and how far it sits from the top-right edges. */
export const TOAST = { width: 460, height: 96, inset: 12 };

const nothing = (): Bounds => ({ x: 0, y: 0, width: 0, height: 0 });

const toastBounds = (contentWidth: number): Bounds => {
  const width = Math.min(TOAST.width, Math.max(0, contentWidth - 2 * TOAST.inset));
  return { x: Math.max(0, contentWidth - TOAST.inset - width), y: TOAST.inset, width, height: TOAST.height };
};

/** The shell page fills the window while the app connects; the server page fills it once
 *  connected. The toast floats top-right over either, and leaves a fullscreen server alone. */
export function layout(content: { width: number; height: number }, mode: PageMode, toast: boolean): { shell: Bounds; remote: Bounds; toast: Bounds } {
  const width = Math.max(0, content.width);
  const height = Math.max(0, content.height);
  const full = { x: 0, y: 0, width, height };
  const toastRect = toast && mode !== "fullscreen" ? toastBounds(width) : nothing();
  if (mode === "shell") return { shell: full, remote: nothing(), toast: toastRect };
  return { shell: nothing(), remote: full, toast: toastRect };
}
