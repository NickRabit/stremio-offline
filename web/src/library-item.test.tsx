import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { folderTitle, LibraryItem, LibraryItemMenu, rowDescription } from "./library-item";
import { setLocale, t } from "./i18n";

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

const render = async (element: React.ReactElement) => {
  await act(async () => { root.render(element); });
};
const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click(); }); };

describe("LibraryItem", () => {
  describe("what a row says", () => {
    it("calls a bound folder by the title it was assigned to and keeps the folder's own name under it", () => {
      expect(folderTitle({ name: "Kriminálka Las Vegas", catalogName: "South Park" })).toBe("South Park");
      expect(folderTitle({ name: "Kriminálka Las Vegas" })).toBe("Kriminálka Las Vegas");
      expect(rowDescription({ kind: "folder", name: "Kriminálka Las Vegas", catalogName: "South Park", description: "A town of misfits." }))
        .toBe("Kriminálka Las Vegas · A town of misfits.");
      expect(rowDescription({ kind: "folder", name: "Kriminálka Las Vegas", description: "A quiet film." }))
        .toBe("A quiet film.");
    });

    it("keeps the catalogue name on a file row, whose own name says nothing about the title", () => {
      expect(rowDescription({ kind: "file", catalogName: "South Park", description: "How to eat with your butt." }))
        .toBe("South Park · How to eat with your butt.");
      expect(rowDescription({ kind: "file", catalogName: "South Park" })).toBe("South Park");
    });

    it("still says what was proposed while nobody has confirmed the row", () => {
      expect(rowDescription({ kind: "folder", match: "suggested", suggestion: { type: "series", id: "tt1", name: "South Park", score: 91, titleSimilarity: 88 } }))
        .toBe(t("library.suggestionLine", { name: "South Park", score: 88 }));
    });
  });

  it("draws the folder row with the local classes and custom attributes", async () => {
    await render(<LibraryItem folder focused selected dataPath="lib_a/films"
      art={<><span className="browse-badge">12</span><i className="fav-mark">star</i></>}
      title="Films" meta="Movies · 12 files" description="An overview" action="Open folder" onOpen={vi.fn()}>
      <button className="browse-select">select</button>
      <LibraryItemMenu name="Films" open={false} onToggle={vi.fn()}><button>item</button></LibraryItemMenu>
    </LibraryItem>);

    const article = host.querySelector("article")!;
    expect(article.className).toBe("browse-item folder focused selected");
    expect(article.getAttribute("data-path")).toBe("lib_a/films");
    expect(article.getAttribute("data-remote-id")).toBeNull();
    expect(article.getAttribute("aria-current")).toBe("true");
    const button = article.querySelector("button.library-open")!;
    expect(button.hasAttribute("disabled")).toBe(false);
    // The picture block is the caller's, badges and marks included.
    expect(button.querySelector(".browse-art > .browse-badge")!.textContent).toBe("12");
    expect(button.querySelector(".browse-art > .fav-mark")).not.toBeNull();
    const copy = button.querySelector(".library-copy")!;
    expect(copy.querySelector("strong")!.textContent).toBe("Films");
    expect(copy.querySelector("small")!.textContent).toBe("Movies · 12 files");
    const description = copy.querySelector("small.library-desc")!;
    expect(description.textContent).toBe("An overview");
    expect(description.getAttribute("title")).toBe("An overview");
    expect(button.querySelector(".library-action")!.textContent).toBe("Open folder");
    expect(article.querySelector(".browse-select")).not.toBeNull();
    expect(article.querySelector(".browse-actions")).toBeNull();
  });

  it("keeps the file modifier and a remote id where each belongs", async () => {
    await render(<LibraryItem dataRemoteId="item-7" art="art" title="One" meta="Movie" action="Play" onOpen={vi.fn()}/>);
    const article = host.querySelector("article")!;
    expect(article.className).toBe("browse-item");
    expect(article.getAttribute("data-remote-id")).toBe("item-7");
    expect(article.getAttribute("data-path")).toBeNull();
    expect(article.getAttribute("aria-current")).toBeNull();
    expect(host.querySelector(".library-desc")).toBeNull();
  });

  it("opens from the button and toggles from the overflow, never the other way round", async () => {
    const onOpen = vi.fn();
    const onToggle = vi.fn();
    await render(<LibraryItem art="art" title="One" meta="Movie" action="Play" onOpen={onOpen}>
      <LibraryItemMenu name="One" open={false} onToggle={onToggle}><button>favorite</button></LibraryItemMenu>
    </LibraryItem>);
    await click(host.querySelector("button.library-open")!);
    expect(onOpen).toHaveBeenCalledTimes(1);
    const menu = host.querySelector("button.browse-menu")!;
    expect(menu.getAttribute("aria-label")).toBe("Options: One");
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    await click(menu);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("draws the overflow items only while the menu is open", async () => {
    const menu = (open: boolean) => <LibraryItem art="art" title="One" meta="Movie" action="Play" onOpen={vi.fn()}>
      <LibraryItemMenu name="One" open={open} onToggle={vi.fn()}><button>favorite</button></LibraryItemMenu>
    </LibraryItem>;
    await render(menu(true));
    expect(host.querySelector(".browse-actions button")!.textContent).toBe("favorite");
    expect(host.querySelector("button.browse-menu")!.getAttribute("aria-expanded")).toBe("true");
    await render(menu(false));
    expect(host.querySelector(".browse-actions")).toBeNull();
  });
});
