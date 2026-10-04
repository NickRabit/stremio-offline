import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NewEpisodesRow } from "./NewEpisodesRow";
import { setLocale } from "./i18n";
import type { FollowView, NewEpisode } from "./types";

const follow: FollowView = {
  id: "f1", ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show",
  createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z",
  enabled: true, revision: 1, nextCheckAt: "2024-01-02T00:00:00.000Z", failures: 0,
  episodeCount: 1, downloads: { queued: 0, waiting: 0, completed: 0, skipped: 0, attention: 0 },
};
const episode: NewEpisode = { followId: "f1", type: "series", metaId: "tt1", name: "Show", videoId: "v1", season: 2, episode: 4, title: "Finale", released: "2024-02-01T00:00:00.000Z" };

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("NewEpisodesRow", () => {
  it("shows nothing while no series is followed", async () => {
    await act(async () => { root.render(<NewEpisodesRow follows={[]} episodes={[episode]} onOpen={() => undefined} onManage={() => undefined}/>); });
    expect(host.querySelector(".resume-row")).toBeNull();
    expect(host.textContent).toBe("");
  });

  it("keeps the subhead when a followed series has nothing new", async () => {
    await act(async () => { root.render(<NewEpisodesRow follows={[follow]} episodes={[]} onOpen={() => undefined} onManage={() => undefined}/>); });
    expect(host.querySelector(".resume-row")).not.toBeNull();
    expect(host.textContent).toContain("Followed series (1)");
    expect(host.textContent).toContain("No new episodes of your followed series.");
  });

  it("names the episode and opens it", async () => {
    const onOpen = vi.fn();
    await act(async () => { root.render(<NewEpisodesRow follows={[follow]} episodes={[episode]} onOpen={onOpen} onManage={() => undefined}/>); });
    expect(host.textContent).toContain("S02E04 · Finale");
    await act(async () => { host.querySelector<HTMLButtonElement>(".resume-strip .browse-item")!.click(); });
    expect(onOpen).toHaveBeenCalledWith(episode);
  });
});
