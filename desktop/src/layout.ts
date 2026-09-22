export const CHROME_HEIGHT = 48;

export interface Bounds { x: number; y: number; width: number; height: number }

export type LayoutMode = "connect" | "remote" | "fullscreen";

const nothing = (): Bounds => ({ x: 0, y: 0, width: 0, height: 0 });

export function layout(content: { width: number; height: number }, mode: LayoutMode): { chrome: Bounds; remote: Bounds } {
  const width = Math.max(0, content.width);
  const height = Math.max(0, content.height);
  if (mode === "connect") return { chrome: { x: 0, y: 0, width, height }, remote: nothing() };
  if (mode === "fullscreen") return { chrome: nothing(), remote: { x: 0, y: 0, width, height } };
  const bar = Math.min(CHROME_HEIGHT, height);
  return { chrome: { x: 0, y: 0, width, height: bar }, remote: { x: 0, y: bar, width, height: height - bar } };
}
