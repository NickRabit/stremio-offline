import { useCallback, useRef, type KeyboardEvent } from "react";

export function useRovingTabs<K extends string>(
  ids: readonly K[],
  selected: K,
  onSelect: (id: K) => void,
): (id: K) => {
  tabIndex: 0 | -1;
  ref: (node: HTMLElement | null) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
} {
  const nodes = useRef(new Map<K, HTMLElement>());
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const onKeyDownFor = useCallback((id: K) => (event: KeyboardEvent<HTMLElement>) => {
    const list = idsRef.current;
    if (!list.length) return;
    const from = list.includes(id) ? id : list.includes(selectedRef.current) ? selectedRef.current : list[0];
    const index = list.indexOf(from);
    let next: K | undefined;
    switch (event.key) {
      case "ArrowRight":
        next = list[(index + 1) % list.length];
        break;
      case "ArrowLeft":
        next = list[(index - 1 + list.length) % list.length];
        break;
      case "Home":
        next = list[0];
        break;
      case "End":
        next = list[list.length - 1];
        break;
      default:
        return;
    }
    event.preventDefault();
    if (next === undefined) return;
    onSelectRef.current(next);
    nodes.current.get(next)?.focus();
  }, []);

  const refs = useRef(new Map<K, (node: HTMLElement | null) => void>());
  const refFor = useCallback((id: K) => {
    let ref = refs.current.get(id);
    if (!ref) {
      ref = (node: HTMLElement | null) => {
        if (node) nodes.current.set(id, node);
        else nodes.current.delete(id);
      };
      refs.current.set(id, ref);
    }
    return ref;
  }, []);

  const active = ids.includes(selected) ? selected : ids[0];
  return (id: K) => ({
    tabIndex: (id === active ? 0 : -1) as 0 | -1,
    ref: refFor(id),
    onKeyDown: onKeyDownFor(id),
  });
}
