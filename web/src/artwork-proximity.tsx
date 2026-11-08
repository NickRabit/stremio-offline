import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from "react";

/** The least reach ahead of the scroll panel. A tall panel reaches one panel height ahead, so the
 *  reach follows the space the grid has rather than a fixed count; a short one, as on a phone,
 *  still looks this far. */
export const ARTWORK_AHEAD_MIN_PX = 600;

export function artworkAhead(root: Element | null): string {
  const height = root ? root.clientHeight : window.innerHeight;
  const ahead = Math.max(ARTWORK_AHEAD_MIN_PX, Math.round(height));
  return `${ahead}px ${Math.round(ahead / 2)}px`;
}

type RegisterArtwork = (element: Element, onIntersect: () => void) => () => void;
type Registration = { onIntersect: () => void };

const ArtworkProximityContext = createContext<RegisterArtwork | null>(null);

// Decided by the style, not by the content: a grid is empty when it mounts and scrolls a moment
// later, while a phone layout that lets the page scroll gives the element no overflow at all.
function artworkRoot(scroller: HTMLElement | null): Element | null {
  if (!scroller) return null;
  const { overflowY } = getComputedStyle(scroller);
  return overflowY === "auto" || overflowY === "scroll" ? scroller : null;
}

export function ArtworkProximity({ scroller, children }: {
  scroller: RefObject<HTMLElement | null>;
  children: ReactNode;
}): JSX.Element {
  const registrations = useRef(new Map<Element, Registration>());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const rootRef = useRef<Element | null>(null);
  const marginRef = useRef("");

  const createObserver = useCallback((force: boolean) => {
    const root = artworkRoot(scroller.current);
    const margin = artworkAhead(root);
    if (!force && observerRef.current && root === rootRef.current && margin === marginRef.current) return;
    marginRef.current = margin;

    observerRef.current?.disconnect();
    rootRef.current = root;
    if (typeof IntersectionObserver === "undefined") {
      observerRef.current = null;
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const registration = registrations.current.get(entry.target);
        if (!registration) continue;
        registrations.current.delete(entry.target);
        observer.unobserve(entry.target);
        registration.onIntersect();
      }
    }, {
      root,
      rootMargin: artworkAhead(root),
    });

    observerRef.current = observer;
    for (const element of registrations.current.keys()) observer.observe(element);
  }, [scroller]);

  useEffect(() => {
    createObserver(true);
    const onResize = () => createObserver(false);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      registrations.current.clear();
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [createObserver]);

  const register = useCallback<RegisterArtwork>((element, onIntersect) => {
    const registration = { onIntersect };
    registrations.current.set(element, registration);
    observerRef.current?.observe(element);

    return () => {
      if (registrations.current.get(element) !== registration) return;
      registrations.current.delete(element);
      observerRef.current?.unobserve(element);
    };
  }, []);

  return <ArtworkProximityContext.Provider value={register}>{children}</ArtworkProximityContext.Provider>;
}

export function useNearScreen(target: RefObject<Element | null>, key: string | undefined): boolean {
  const register = useContext(ArtworkProximityContext);
  // The picture that came near; a tile showing another one is lazy again until it does too.
  const [nearKey, setNearKey] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!register || key === undefined) return;
    const element = target.current;
    if (!element || typeof IntersectionObserver === "undefined") return;

    let active = true;
    const unregister = register(element, () => {
      if (active) setNearKey(key);
    });
    return () => {
      active = false;
      unregister();
    };
  }, [key, register, target]);

  return key !== undefined && nearKey === key;
}
