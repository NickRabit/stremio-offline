import type { HomeCard, HomeRowId } from "../../server/src/home";

const pad = (value: number) => String(value).padStart(2, "0");

/** The catalogue key a card's caption leads with. A completed file and a favourite carry no
 *  label of their own, so their caption is just the numbering. */
export type CardLabel = "home.resume" | "home.openEpisode" | "home.openTitle" | "home.nextEpisode" | "player.play";

export function cardLabel(card: HomeCard): CardLabel | undefined {
  if (card.kind === "resume-file") return "home.resume";
  if (card.kind === "completed") return "player.play";
  if (card.kind !== "resume-catalogue") return undefined;
  if (card.pending) return "home.nextEpisode";
  return card.type === "series" ? "home.openEpisode" : "home.openTitle";
}

/** `S02E04`, when the card carries both numbers. A stored position usually does; a pending
 *  next episode always does. */
export function cardNumbering(card: HomeCard): string | undefined {
  const { season, episode } = card as { season?: number; episode?: number };
  return typeof season === "number" && typeof episode === "number" ? `S${pad(season)}E${pad(episode)}` : undefined;
}

/** The progress bar a card draws, as a whole percent. A pending next episode has none: it is
 *  not a position, and an invented 0% bar would be a lie. */
export function cardProgress(card: HomeCard): number | null {
  const progress = card.kind === "resume-file" ? card.progress
    : card.kind === "resume-catalogue" && !card.pending ? card.progress
    : undefined;
  if (!progress) return null;
  if (!(progress.duration > 0)) return 0;
  return Math.min(100, Math.max(0, Math.round((progress.position / progress.duration) * 100)));
}

export type ShowAllTarget = "library-resume" | "catalog-resume" | "downloads" | "library-favorites";

/** Where "Show all" goes, or nothing when the row has no more than what it shows. Favourites
 *  always offers the library's list; Continue watching picks the library when it holds a local
 *  card and the catalogue otherwise. */
export function showAllTarget(row: HomeRowId, cards: HomeCard[], hasMore: boolean): ShowAllTarget | undefined {
  if (row === "favorites") return "library-favorites";
  if (!hasMore) return undefined;
  if (row === "completed") return "downloads";
  return cards.some((card) => card.kind === "resume-file") ? "library-resume" : "catalog-resume";
}
