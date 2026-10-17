import { useState } from "react";
import { Film, FolderOpen, HardDrive, MoreVertical, RotateCcw } from "lucide-react";
import { TileArt } from "./TileArt";
import { localeTag, t } from "./i18n";
import { cardLabel, cardNumbering, cardProgress, relativeAge } from "./home-cards";
import type { HomeCard as HomeCardData } from "../../server/src/home";
import type { TileShape } from "./types";

export interface HomeCardActions {
  play: (card: HomeCardData) => void;
  open: (card: HomeCardData) => void;
  reveal: (path: string) => void;
  forget: (card: HomeCardData) => void;
}

/** The card's own line: its label, its numbering and whatever else the kind adds. No card names
 *  the library or media server it came from: a list is about titles, not about sources. */
function captionOf(card: HomeCardData, locale: string): string {
  const label = cardLabel(card);
  const parts: Array<string | undefined> = [label && t(label), cardNumbering(card)];
  if (card.kind === "resume-file") parts.push(card.subtitle);
  if (card.kind === "episode") parts.push(new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(new Date(card.released)));
  if (card.kind === "recent") parts.push(relativeAge(card.addedAt, Date.now(), locale));
  if (card.kind === "tonight") parts.push(card.year);
  if (card.kind === "discovery") parts.push(card.year);
  if (card.kind === "favorite-catalogue") parts.push(card.year);
  if (card.kind === "confirm") parts.push(t("home.confirmGuess", { name: card.candidate.year ? `${card.candidate.name} (${card.candidate.year})` : card.candidate.name }));
  return parts.filter(Boolean).join(" · ");
}

const titleOf = (card: HomeCardData): string =>
  card.kind === "favorite" || card.kind === "recent" || card.kind === "tonight" || card.kind === "confirm" ? card.label
  : card.kind === "episode" || card.kind === "discovery" || card.kind === "favorite-catalogue" ? card.name
  : card.title;

/** Kinds that point at a library path the card or its menu can reveal. */
const hasPath = (card: HomeCardData): card is Extract<HomeCardData, { path: string }> =>
  card.kind === "resume-file" || card.kind === "completed" || card.kind === "favorite" || card.kind === "recent" || card.kind === "tonight";

/** One card on a Home shelf. The artwork and the caption are a single button; the overflow
 *  control is a sibling, so a tap on one never lands on the other. */
export function HomeCard({ card, shape, actions }: { card: HomeCardData; shape: TileShape; actions: HomeCardActions }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const percent = cardProgress(card);
  const title = titleOf(card);
  const caption = captionOf(card, localeTag());
  const folder = (card.kind === "favorite" || card.kind === "tonight") && card.itemKind === "folder";
  const poster = card.kind === "confirm" ? card.candidate.poster : card.poster;
  // Every kind that can carry a background draws it: a wide tile of a suggestion, a new episode
  // or a starred catalogue title letterboxes only when the card really has no wide picture.
  const wide = card.wide;
  // A new episode and a suggestion are the whole card: nothing behind an overflow button.
  const menu = card.kind !== "episode" && card.kind !== "discovery" && card.kind !== "confirm" && card.kind !== "favorite-catalogue";

  const primary = () => {
    // Continue watching plays whatever wrote it: a media-server version, an addon source or a file.
    if (card.kind === "remote" || card.kind === "resume-catalogue") { actions.play(card); return; }
    if (card.kind === "episode" || card.kind === "discovery" || card.kind === "confirm" || card.kind === "favorite-catalogue") { actions.open(card); return; }
    // A favourite bound to a title is that title, whatever kind of copy it is.
    if (card.kind === "favorite" && card.title) { actions.open(card); return; }
    // A Tonight card the libraries bound to a title opens that title instead of its folder.
    if (card.kind === "tonight" && card.title) { actions.open(card); return; }
    if (folder) { actions.reveal(card.path); return; }
    actions.play(card);
  };

  return <article className="browse-item home-card" data-kind={card.kind}>
    <div className="browse-frame">
      <button className="browse-open" title={title} onClick={primary}>
        <span className="browse-art"><TileArt shape={shape} poster={poster} wide={wide} fallback={folder ? <FolderOpen/> : <Film/>}/>
          {percent != null && <i className="resume-bar"><i style={{ width: `${percent}%` }}/></i>}</span>
        <strong>{title}</strong>
        <small className={card.kind === "confirm" ? "home-candidate" : undefined} title={caption}>{caption}</small>
      </button>
      {menu && <button className="browse-menu" aria-label={t("home.menu", { title })} aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><MoreVertical/></button>}
    </div>
    {menu && menuOpen && <span className="browse-actions home-actions" onClick={(event) => event.stopPropagation()}>
      {((card.kind === "resume-file" && card.identity) || card.kind === "resume-catalogue") && <button onClick={() => { setMenuOpen(false); actions.open(card); }}><Film/> {t("home.openDetail")}</button>}
      {hasPath(card) && <button onClick={() => { setMenuOpen(false); actions.reveal(card.path); }}><HardDrive/> {t("library.showInLibrary")}</button>}
      {(card.kind === "resume-file" || card.kind === "resume-catalogue" || card.kind === "remote") && <button onClick={() => { setMenuOpen(false); actions.forget(card); }}><RotateCcw/> {t("home.forget")}</button>}
    </span>}
  </article>;
}
