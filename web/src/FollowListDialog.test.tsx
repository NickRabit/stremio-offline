import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FollowListDialog } from "./FollowListDialog";
import { setLocale } from "./i18n";
import type { FollowView } from "./types";

const follow = (overrides: Partial<FollowView>): FollowView => ({
  id: "f1", ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show",
  createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z",
  enabled: true, revision: 1, nextCheckAt: "2024-01-02T00:00:00.000Z", failures: 0,
  episodeCount: 3,
  downloads: { queued: 0, waiting: 0, completed: 0, skipped: 0, attention: 0 },
  ...overrides,
});

let root: Root;
let host: HTMLDivElement;

const render = async (follows: FollowView[]) => {
  await act(async () => {
    root.render(<FollowListDialog follows={follows} languages={[]} libraries={[]} addons={[]} audioLanguage="en" subtitleLanguage="en"
      onChanged={() => undefined} onClose={() => undefined} onNotify={() => undefined}/>);
  });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("FollowListDialog", () => {
  it("shows the next episode, or the last released one when nothing is announced", async () => {
    await render([
      follow({ id: "a", name: "Next", nextEpisode: { season: 1, episode: 2, released: "2030-01-01" }, latestEpisode: { season: 1, episode: 1, released: "2023-01-01" } }),
      follow({ id: "b", name: "Latest", latestEpisode: { season: 1, episode: 3, released: "2023-01-08" } }),
      follow({ id: "c", name: "None" }),
    ]);

    const row = (name: string) => [...host.querySelectorAll<HTMLElement>(".follow-row")].find((item) => item.textContent?.includes(name))!.querySelector("small")!;
    expect(row("Next").textContent).toContain("Next episode: S01E02");
    expect(row("Latest").textContent).toContain("Latest: S01E03");
    expect(row("None").textContent).toBe("No upcoming episode announced");
  });
});
