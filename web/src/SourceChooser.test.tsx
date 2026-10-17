import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SourceChooser, type SourceChooserProps } from "./SourceChooser";
import { setLocale } from "./i18n";
import type { LibrarySourceGroup, LibrarySourcePanel } from "./library-sources";
import type { Stream } from "./types";

/** A version of the viewer's own library: the file itself, already on the server's disk. */
const file = (id: string, name: string, size?: number): Stream => ({
  sourceId: id, kind: "library", playable: true, name, localPath: `Films/${name}.mkv`, libraryName: "Films",
  ...(size === undefined ? {} : { behaviorHints: { videoSize: size } }),
});
/** An addon answer: no provider and no remote context, only its own addon and source id. */
const addon = (id: string, name: string, size?: number): Stream => ({
  sourceId: id, kind: "remote", playable: true, name, addonKey: "torrentio", addonName: "Torrentio",
  ...(size === undefined ? {} : { behaviorHints: { videoSize: size } }),
});
const addonGroup = (streams: Stream[], over: Partial<LibrarySourceGroup> = {}): LibrarySourceGroup =>
  ({ key: "addon:torrentio", kind: "addon", name: "Torrentio", status: "loaded", streams, error: "", ...over });
const ownCopies = (streams: Stream[], over: Partial<LibrarySourceGroup> = {}): LibrarySourceGroup =>
  ({ key: "local", kind: "local", name: "", status: "loaded", streams, error: "", ...over });

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (over: Partial<SourceChooserProps> = {}) => {
  const props: SourceChooserProps = {
    lead: [file("local-1", "One")], leadLabel: "Local files", groups: [], selected: null,
    onSelect: vi.fn(), preferredLanguage: "en", ...over,
  };
  act(() => root.render(<SourceChooser {...props}/>));
  return props;
};
const rows = () => [...host.querySelectorAll<HTMLButtonElement>(".stream-list button")];
const selects = () => [...host.querySelectorAll<HTMLSelectElement>("select")];
const choose = (select: HTMLSelectElement, value: string) =>
  act(() => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });

describe("SourceChooser", () => {
  it("leads the list with the rows the place holds, under the label it gave them", () => {
    const mine = file("local-1", "One");
    render({ lead: [mine], leadLabel: "Local files", groups: [addonGroup([addon("a1", "4K", 8_000_000_000)])] });
    // The place's own row heads the list, drawn with the one row template every chooser draws.
    expect(rows().map((row) => row.textContent)).toEqual([expect.stringContaining("One"), expect.stringContaining("4K")]);
    expect(rows()[0]!.querySelector("i")!.textContent).toBe("Local");
    expect(rows()[1]!.querySelector("i")!.textContent).toBe("HTTP");
    // The menus name the classes by the very label the place handed over, and count what they hold.
    expect([...selects()[0]!.options].map((option) => option.textContent)).toEqual([
      "All sources (2)", "Local files (1)", "Torrentio (1)",
    ]);
  });

  it("lists the row the place holds first and pressed, and ranks it with the others by size", () => {
    const large = file("local-1", "Large", 8_000_000_000);
    const small = file("local-2", "Small", 100);
    render({ lead: [large, small], selected: small });
    expect(rows().map((row) => row.textContent)).toEqual([expect.stringContaining("Small"), expect.stringContaining("Large")]);
    expect(rows()[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(rows()[1]!.getAttribute("aria-pressed")).toBe("false");
    choose(selects()[1]!, "size-desc");
    // A named size sort is about the sizes: the row the place holds is listed and marked where
    // its own size puts it.
    expect(rows().map((row) => row.textContent)).toEqual([expect.stringContaining("Large"), expect.stringContaining("Small")]);
    expect(rows()[1]!.getAttribute("aria-pressed")).toBe("true");
  });

  it("narrows the list by source class and by language", () => {
    const mine = file("local-1", "One");
    render({
      lead: [mine], groups: [addonGroup([addon("a1", "4K Czech", 8_000_000_000), addon("a2", "4K English", 8_000_000_000)])],
    });
    choose(selects()[0]!, "addon:torrentio");
    expect(rows()).toHaveLength(2);
    choose(selects()[1]!, "cs");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain("4K Czech");
  });

  it("shows a group that failed with its own retry, and asks only that one again", () => {
    const retry = vi.fn();
    const failed = addonGroup([], { status: "error", error: "Torrentio is down" });
    const panel: LibrarySourcePanel = { groups: [failed], retry };
    render({ groups: [failed], panel });
    const notice = host.querySelector<HTMLElement>(".notice")!;
    expect(notice.textContent).toContain("Torrentio is down");
    act(() => (notice.querySelector("button") as HTMLButtonElement).click());
    expect(retry).toHaveBeenCalledWith("addon:torrentio");
  });

  it("folds the copies the lead already holds out of the own-copies group", () => {
    const mine = file("local-1", "One");
    render({ lead: [mine], leadLabel: "Local files", groups: [ownCopies([mine]), addonGroup([addon("a1", "4K")])] });
    // The file the place holds is one row under one entry: the group that would name it a second
    // time is not offered at all, and the count does not claim a row that is not there.
    expect(rows().map((row) => row.textContent)).toEqual([expect.stringContaining("One"), expect.stringContaining("4K")]);
    expect([...selects()[0]!.options].map((option) => option.textContent)).toEqual([
      "All sources (2)", "Local files (1)", "Torrentio (1)",
    ]);
  });

  it("draws the bare row the player leads with from the fuller copy the own-copies group knows", () => {
    const playing: Stream = { sourceId: "play-1", kind: "library", playable: true, name: "One", localPath: "Films/One.mkv" };
    render({ lead: [playing], selected: playing, groups: [ownCopies([file("local-1", "One", 1_073_741_824)])] });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain("1.1 GB");
    expect(rows()[0]!.textContent).toContain("Films");
    expect(rows()[0]!.getAttribute("aria-pressed")).toBe("true");
  });

  it("names an addon row the lead holds by its addon once the addon's group answers", () => {
    const row = addon("a1", "4K");
    render({ lead: [row], leadLabel: "Sources", groups: [addonGroup([row, addon("a2", "1080p")])] });
    expect(rows()).toHaveLength(2);
    expect([...selects()[0]!.options].map((option) => option.textContent)).toEqual(["All sources (2)", "Torrentio (2)"]);
  });

  it("keeps a copy of the title the lead does not hold in the own-copies group", () => {
    const mine = file("local-1", "One");
    const other = file("local-2", "Two");
    render({ lead: [mine], leadLabel: "Local files", groups: [ownCopies([mine, other])] });
    expect(rows().map((row) => row.textContent)).toEqual([expect.stringContaining("One"), expect.stringContaining("Two")]);
  });

  it("says the list is still arriving while a group is out, never that nothing was found", () => {
    render({ groups: [addonGroup([], { status: "loading" })] });
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Asking the other sources…");
  });
});
