import { useEffect } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { t } from "./i18n";
import { hideBroken } from "./settings-ui";

export type GalleryKind = "poster" | "background" | "logo" | "still";
export type GalleryImage = { url: string; label: string; shape: "poster" | "wide"; kind: GalleryKind };

export function MediaGallery({ images, index, onIndex, onClose }: { images: GalleryImage[]; index: number; onIndex: (index: number) => void; onClose: () => void }) {
  const current = images[index];
  const move = (step: number) => onIndex((index + step + images.length) % images.length);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowLeft" && images.length > 1) move(-1);
      else if (event.key === "ArrowRight" && images.length > 1) move(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, images.length]);
  return <div className="gallery-overlay" role="dialog" aria-modal="true" aria-label={t("gallery.title")} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <button className="gallery-close icon-button" aria-label={t("gallery.close")} onClick={onClose}><X/></button>
    {images.length > 1 && <button className="gallery-arrow previous" aria-label={t("gallery.previous")} onClick={() => move(-1)}><ChevronLeft/></button>}
    <figure><img className={current.shape} src={current.url} alt={current.label} onError={hideBroken}/><figcaption>{t("gallery.caption", { label: current.label, index: index + 1, total: images.length })}</figcaption></figure>
    {images.length > 1 && <button className="gallery-arrow next" aria-label={t("gallery.next")} onClick={() => move(1)}><ChevronRight/></button>}
    {images.length > 1 && <div className="gallery-thumbnails">{images.map((image, itemIndex) => <button key={image.url} className={itemIndex === index ? "selected" : ""} aria-label={t("gallery.show", { label: image.label })} onClick={() => onIndex(itemIndex)}><img src={image.url} alt="" loading="lazy" onError={hideBroken}/></button>)}</div>}
  </div>;
}
