import { useState } from "react";
import { Film, FolderOpen, HardDrive, MoreVertical, RotateCcw } from "lucide-react";
import { TileArt } from "./TileArt";
import { t } from "./i18n";
import { cardLabel, cardNumbering, cardProgress } from "./home-cards";
import type { MediaHomeCard as HomeCardData } from "../../server/src/home";
import type { TileShape } from "./types";

export interface HomeCardActions {
  play: (card: HomeCardData) => void;
  open: (card: HomeCardData) => void;
  reveal: (path: string) => void;
  forget: (card: HomeCardData) => void;
}

/** One card on a Home shelf. The artwork and the caption are a single button; the overflow
 *  control is a sibling, so a tap on one never lands on the other. */
export function HomeCard({ card, shape, actions }: { card: HomeCardData; shape: TileShape; actions: HomeCardActions }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const label = cardLabel(card);
  const numbering = cardNumbering(card);
  const percent = cardProgress(card);
  const title = card.kind === "favorite" ? card.label : card.title;
  const caption = [label && t(label), numbering, card.kind === "resume-file" ? card.subtitle : undefined].filter(Boolean).join(" · ");
  const folder = card.kind === "favorite" && card.itemKind === "folder";

  const primary = () => {
    if (card.kind === "resume-catalogue") { actions.open(card); return; }
    if (folder) { actions.reveal(card.path); return; }
    actions.play(card);
  };

  return <article className="browse-item home-card" data-kind={card.kind}>
    <div className="browse-frame">
      <button className="browse-open" title={title} onClick={primary}>
        <span className="browse-art"><TileArt shape={shape} poster={card.poster} wide={card.wide} fallback={folder ? <FolderOpen/> : <Film/>}/>
          {percent != null && <i className="resume-bar"><i style={{ width: `${percent}%` }}/></i>}</span>
        <strong>{title}</strong>
        <small title={caption}>{caption}</small>
      </button>
      <button className="browse-menu" aria-label={t("home.menu", { title })} aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><MoreVertical/></button>
    </div>
    {menuOpen && <span className="browse-actions home-actions" onClick={(event) => event.stopPropagation()}>
      {card.kind !== "resume-catalogue" && <button onClick={() => { setMenuOpen(false); actions.reveal(card.path); }}><HardDrive/> {t("library.showInLibrary")}</button>}
      {(card.kind === "resume-file" || card.kind === "resume-catalogue") && <button onClick={() => { setMenuOpen(false); actions.forget(card); }}><RotateCcw/> {t("home.forget")}</button>}
    </span>}
  </article>;
}
