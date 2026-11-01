import { useLayoutEffect, useRef } from "react";

/** A breadcrumb trail that scrolls sideways on a small screen opens at its end, on the current
 *  item; [trail] names the steps, so the trail moves only when they change. */
export function useCrumbsAtEnd<T extends HTMLElement>(trail: string) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node && node.scrollWidth > node.clientWidth) node.scrollLeft = node.scrollWidth;
  }, [trail]);
  return ref;
}
