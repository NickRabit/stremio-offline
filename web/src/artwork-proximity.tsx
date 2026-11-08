import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ImgHTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";

/** The least reach ahead of the scroll panel. A tall panel reaches one panel height ahead, so the
 *  reach follows the space the grid has rather than a fixed count; a short one, as on a phone,
 *  still looks this far. */
export const ARTWORK_AHEAD_MIN_PX = 600;

/** The element that scrolls `element`: itself or its nearest ancestor whose style scrolls it,
 *  decided by style rather than content (an empty grid scrolls a moment later); null for the page. */
export function scrollingAncestor(element: Element | null): Element | null {
  for (let node = element; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(node);
    if (overflowX === "auto" || overflowX === "scroll" || overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

export function artworkAhead(root: Element | null): string {
  const vertical = Math.max(ARTWORK_AHEAD_MIN_PX, root ? root.clientHeight : window.innerHeight);
  const horizontal = Math.max(ARTWORK_AHEAD_MIN_PX / 2, Math.round((root ? root.clientWidth : window.innerWidth) / 2));
  return `${vertical}px ${horizontal}px`;
}

type RegisterArtwork = (element: Element, onIntersect: () => void) => () => void;
type Registration = { onIntersect: () => void };

const ArtworkProximityContext = createContext<RegisterArtwork | null>(null);

export function ArtworkProximity({ scroller, children }: {
  scroller: RefObject<HTMLElement | null>;
  children: ReactNode;
}): JSX.Element {
  const registrations = useRef(new Map<Element, Registration>());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const rootRef = useRef<Element | null>(null);
  const marginRef = useRef("");
  const evaluatedRef = useRef(false);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const resizeTargetsRef = useRef(new Set<Element>());
  const resizeFrameRef = useRef<number | null>(null);

  const pointResizeObserver = useCallback((scrollerElement: Element | null, root: Element | null) => {
    const observer = resizeObserverRef.current;
    if (!observer) return;
    const next = new Set<Element>();
    if (scrollerElement) next.add(scrollerElement);
    if (root) next.add(root);
    const previous = resizeTargetsRef.current;
    if (previous.size === next.size && [...next].every((element) => previous.has(element))) return;
    for (const element of previous) if (!next.has(element)) observer.unobserve(element);
    for (const element of next) if (!previous.has(element)) observer.observe(element);
    resizeTargetsRef.current = next;
  }, []);

  const createObserver = useCallback((force: boolean) => {
    const scrollerElement = scroller.current;
    const root = scrollingAncestor(scrollerElement);
    const margin = artworkAhead(root);
    pointResizeObserver(scrollerElement, root);
    if (!force && evaluatedRef.current && root === rootRef.current && margin === marginRef.current) return;
    evaluatedRef.current = true;
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
  }, [pointResizeObserver, scroller]);

  useEffect(() => {
    createObserver(true);
    const onResize = () => createObserver(false);
    window.addEventListener("resize", onResize);
    if (typeof ResizeObserver !== "undefined") {
      const resizeObserver = new ResizeObserver(() => {
        if (resizeFrameRef.current !== null) return;
        resizeFrameRef.current = window.requestAnimationFrame(() => {
          resizeFrameRef.current = null;
          createObserver(false);
        });
      });
      resizeObserverRef.current = resizeObserver;
      pointResizeObserver(scroller.current, rootRef.current);
    }
    return () => {
      window.removeEventListener("resize", onResize);
      if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      resizeTargetsRef.current.clear();
      registrations.current.clear();
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [createObserver, pointResizeObserver]);

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

export function NearImage({ src, ...props }: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const image = useRef<HTMLImageElement>(null);
  const near = useNearScreen(image, src);
  return <img {...props} ref={image} src={src} decoding="async" loading={near ? "eager" : "lazy"}/>;
}
