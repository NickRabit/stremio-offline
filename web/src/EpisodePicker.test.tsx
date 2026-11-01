import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EpisodePicker, type PickerEpisode } from "./EpisodePicker";
import { setLocale } from "./i18n";

const episodes: PickerEpisode[] = [
  { key: "/show/special.mkv", season: 0, episode: 1, title: "Special" },
  { key: "/show/s01e01.mkv", season: 1, episode: 1, title: "First" },
  { key: "/show/s02e01.mkv", season: 2, episode: 1, title: "Second season" },
];

function Harness({ selected = null, open = true, onPick = vi.fn(), onOpenChange = vi.fn() }: {
  selected?: string | null;
  open?: boolean;
  onPick?: (key: string) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [selectedKey, setSelectedKey] = useState(selected);
  const [isOpen, setIsOpen] = useState(open);
  const [season, setSeason] = useState<number | null>(null);
  return <EpisodePicker
    episodes={episodes}
    selectedKey={selectedKey}
    onPick={(key) => { onPick(key); setSelectedKey(key); }}
    open={isOpen}
    onOpenChange={(next) => { onOpenChange(next); setIsOpen(next); }}
    loading={false}
    season={season}
    onSeason={setSeason}
  />;
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("cs");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const click = async (element: Element | null) => {
  await act(async () => { (element as HTMLElement).click(); });
};

describe("EpisodePicker", () => {
  it("shows the chosen episode until the viewer opens the list", async () => {
    await act(async () => { root.render(<Harness selected="/show/s01e01.mkv" open={false}/>); });

    expect(host.querySelector(".episode-current")!.textContent).toContain("01×01First");
    expect(host.querySelector(".episode-list")).toBeNull();

    await click(host.querySelector(".episode-current button"));
    expect(host.querySelector(".episode-current")).toBeNull();
    expect(host.querySelectorAll(".episode-list button")).toHaveLength(1);
  });

  it("filters by the selected season and lists specials last", async () => {
    await act(async () => { root.render(<Harness/>); });

    const select = host.querySelector<HTMLSelectElement>(".season-select")!;
    expect([...select.options].map((option) => option.textContent)).toEqual(["1. série", "2. série", "Speciály"]);
    expect([...select.options].map((option) => option.value)).toEqual(["1", "2", "0"]);
    expect([...host.querySelectorAll(".episode-list button b")].map((node) => node.textContent)).toEqual(["01×01"]);

    await act(async () => {
      select.value = "2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect([...host.querySelectorAll(".episode-list button b")].map((node) => node.textContent)).toEqual(["02×01"]);

    await act(async () => {
      select.value = "0";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect([...host.querySelectorAll(".episode-list button b")].map((node) => node.textContent)).toEqual(["00×01"]);
  });

  it("another season chooses its first episode and keeps the list open", async () => {
    const onPick = vi.fn();
    await act(async () => { root.render(<Harness selected="/show/s01e01.mkv" onPick={onPick}/>); });
    const select = host.querySelector<HTMLSelectElement>(".season-select")!;

    await act(async () => {
      select.value = "2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Play and the source row below follow the season, not the episode of the one just left.
    expect(onPick).toHaveBeenCalledWith("/show/s02e01.mkv");
    expect(host.querySelector(".episode-list button.selected b")!.textContent).toBe("02×01");
    expect(host.querySelector(".episode-current")).toBeNull();
  });

  it("picks an episode and closes the list", async () => {
    const onPick = vi.fn();
    const onOpenChange = vi.fn();
    await act(async () => { root.render(<Harness onPick={onPick} onOpenChange={onOpenChange}/>); });

    await click(host.querySelector(".episode-list button"));
    expect(onPick).toHaveBeenCalledWith("/show/s01e01.mkv");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(host.querySelector(".episode-list")).toBeNull();
    expect(host.querySelector(".episode-current")!.textContent).toContain("First");
  });
});
