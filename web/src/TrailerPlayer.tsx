import { useEffect } from "react";
import { X } from "lucide-react";
import { t, useI18n } from "./i18n";
import type { Trailer } from "./types";

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

export function TrailerPlayer({ trailer, onClose }: { trailer: Trailer | null; onClose: () => void }) {
  const { t: translate } = useI18n();
  useEffect(() => {
    if (!trailer) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [trailer, onClose]);
  if (!trailer || !YOUTUBE_ID.test(trailer.youtubeId)) return null;
  const source = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(trailer.youtubeId)}?autoplay=1&rel=0`;
  return <section className="trailer-overlay" role="dialog" aria-modal="true" aria-label={translate("trailers.playerTitle")}>
    <header className="trailer-head"><strong>{trailer.title || t("trailers.playerTitle")}</strong><button onClick={onClose} title={translate("trailers.close")}><X/> {translate("trailers.close")}</button></header>
    <iframe src={source} title={translate("trailers.playerTitle")} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen/>
  </section>;
}
