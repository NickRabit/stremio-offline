import { Component, lazy, useState, type ComponentType, type ReactNode } from "react";
import { t } from "./i18n";

/**
 * One import promise per screen, shared by `Screen` and `preload`. Once the import has resolved,
 * `Screen` draws the component directly, so a screen preloaded at idle never suspends. Before
 * that it goes through `React.lazy` under the caller's Suspense. A failed import is forgotten, so
 * the next preload tries again; a render that already failed is retried by a reload.
 */
export function lazyScreen<P extends object>(load: () => Promise<ComponentType<P>>): {
  Screen: ComponentType<P>;
  preload: () => Promise<void>;
  ready: () => boolean;
} {
  let current: Promise<ComponentType<P>> | null = null;
  let loaded: ComponentType<P> | null = null;
  const start = (): Promise<ComponentType<P>> => {
    current ??= load().then(
      (component) => { loaded = component; return component; },
      (error: unknown) => { current = null; throw error; },
    );
    return current;
  };
  const Lazy = lazy(() => start().then((component) => ({ default: component })));
  // Chosen once per mount: switching from Lazy to the loaded component later would remount the screen.
  const Screen = (props: P) => {
    const [Chosen] = useState<ComponentType<P>>(() => loaded ?? Lazy);
    return <Chosen {...props}/>;
  };
  return {
    Screen,
    preload: () => start().then(() => undefined, () => undefined),
    ready: () => loaded !== null,
  };
}

type BoundaryState = { failed: boolean };

/** The chunk's hashed name may be gone after a deploy, so the retry is a full reload. */
export class LazyScreenBoundary extends Component<{ children: ReactNode; reload?: () => void }, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="home-note bad"><span>{t("api.unreachable")}</span><button className="home-retry" onClick={() => (this.props.reload ?? (() => window.location.reload()))()}>{t("common.retry")}</button></div>;
  }
}
