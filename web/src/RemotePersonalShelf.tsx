import { useEffect, useRef, useState } from "react";
import { api, describeError } from "./api";
import { HomeCard, type HomeCardActions } from "./HomeCard";
import { t } from "./i18n";
import type { TileShape } from "./types";
import type { HomeCard as HomeCardData, RemoteHomeCard } from "../../server/src/home";

const PAGE = 40;
const aborted = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/** The media-server stars of the Favourites page, loaded on their own so a slow or absent
 *  server never touches the filesystem and catalogue stars above. */
export function RemotePersonalShelf({ refreshToken, shape, onOpen, onForgotten, onError }: {
  refreshToken: number;
  shape: TileShape;
  onOpen: (card: HomeCardData) => void;
  onForgotten: () => void;
  onError: (error: unknown) => void;
}) {
  const [items, setItems] = useState<RemoteHomeCard[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [partial, setPartial] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const moreAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    moreAbort.current?.abort();
    moreAbort.current = null;
    setBusy(true);
    setLoadingMore(false);
    setError("");
    void api.remotePersonal("favorites", { skip: 0, limit: PAGE, signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted) return;
        setItems(page.items);
        setTotal(page.total);
        setPartial(Boolean(page.partial));
      })
      .catch((value) => {
        if (controller.signal.aborted || aborted(value)) return;
        setError(describeError(value));
      })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { controller.abort(); moreAbort.current?.abort(); };
  }, [refreshToken, attempt]);

  const loadMore = async () => {
    const controller = new AbortController();
    moreAbort.current?.abort();
    moreAbort.current = controller;
    setLoadingMore(true);
    try {
      const page = await api.remotePersonal("favorites", { skip: items.length, limit: PAGE, signal: controller.signal });
      if (controller.signal.aborted) return;
      // Pages shift as positions change, so a card already drawn is never added twice.
      setItems((previous) => {
        const seen = new Set(previous.map((card) => card.key));
        return [...previous, ...page.items.filter((card) => !seen.has(card.key))];
      });
      setTotal(page.total);
      setPartial(Boolean(page.partial));
    } catch (value) {
      if (!controller.signal.aborted && !aborted(value)) onError(value);
    } finally {
      if (moreAbort.current === controller) setLoadingMore(false);
    }
  };

  const forget = (card: HomeCardData) => {
    if (card.kind !== "remote") return;
    if (!window.confirm(t("home.forgetConfirm", { title: card.title }))) return;
    void api.saveRemoteState(card.libraryId, card.itemId, { position: 0, duration: 0 }).then(onForgotten, onError);
  };
  const actions: HomeCardActions = { play: onOpen, open: onOpen, reveal: () => undefined, forget };

  if (!error && !partial && !items.length) return null;
  return <section className="home-row remote-personal">
    <div className="subhead"><div className="home-head"><h3>{t("favorites.remoteTitle")}</h3></div></div>
    {error
      ? <div className="home-note bad" role="alert"><span>{error}</span><button className="home-retry" onClick={() => setAttempt((value) => value + 1)}>{t("home.retry")}</button></div>
      : <>
          {partial && <div className="home-note" role="status"><span>{t("favorites.remotePartial")}</span><button className="home-retry" onClick={() => setAttempt((value) => value + 1)}>{t("home.retry")}</button></div>}
          <div className={`resume-strip${busy ? " refreshing" : ""}`} aria-busy={busy || undefined} data-shape={shape}>
            {items.map((card) => <HomeCard key={card.key} card={card} shape={shape} actions={actions}/>)}
          </div>
        </>}
    {items.length > 0 && items.length < total && <div className="load-more">
      {loadingMore ? <span>{t("common.loadingMore")}</span> : <button onClick={() => void loadMore()}>{t("common.loadMore")}</button>}
    </div>}
  </section>;
}
