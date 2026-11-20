import { toCssPx } from "./ui-scale";

export type ScrollSnapshot = {
  windowY: number;
  elements: Array<{ node: Element; top: number }>;
};

const scrollRoot = (): ParentNode => document.querySelector("main") ?? document;

export function captureScroll(root: ParentNode = scrollRoot()): ScrollSnapshot {
  const elements: Array<{ node: Element; top: number }> = [];
  const consider = (node: Element) => {
    if (node instanceof HTMLElement && node.scrollTop > 0) elements.push({ node, top: node.scrollTop });
  };
  if (root instanceof Element) consider(root);
  for (const node of root.querySelectorAll("*")) consider(node);
  return { windowY: window.scrollY, elements };
}

export function restoreScroll(snapshot: ScrollSnapshot): void {
  window.scrollTo(0, snapshot.windowY);
  for (const { node, top } of snapshot.elements) {
    if (!node.isConnected || !(node instanceof HTMLElement)) continue;
    node.scrollTop = top;
  }
}

export function snapshotScrollTop(snapshot: ScrollSnapshot): number {
  return snapshot.elements[0]?.top ?? toCssPx(snapshot.windowY);
}
