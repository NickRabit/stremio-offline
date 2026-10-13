import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChevronRight, FolderOpen, HardDrive } from "lucide-react";
import { LibraryTile } from "./library-tile";
import { setLocale } from "./i18n";

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

const action = <><FolderOpen/> Open folder <ChevronRight/></>;

describe("LibraryTile", () => {
  it("draws the same library tile the local root always drew", async () => {
    await render(<LibraryTile name="Films" meta="Movies · 12 files" posters={["a", "b"]} fallback={<HardDrive/>}
      count={12} enabled path="lib_00000001" action={action} onOpen={vi.fn()}/>);

    const article = host.querySelector("article")!;
    expect(article.className).toBe("browse-item library");
    expect(article.getAttribute("data-path")).toBe("lib_00000001");
    const button = article.querySelector("button.library-open")!;
    expect(button.hasAttribute("disabled")).toBe(false);
    // More than one poster draws the aria-hidden collage, exactly as the local tile always has.
    const collage = button.querySelector(".browse-art > .library-preview-collage")!;
    expect(collage.getAttribute("aria-hidden")).toBe("true");
    expect([...collage.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual(["a", "b"]);
    expect(button.querySelector(".browse-badge")!.textContent).toBe("12");
    const copy = button.querySelector(".library-copy")!;
    expect(copy.querySelector("strong")!.textContent).toBe("Films");
    expect(copy.querySelector("small")!.textContent).toBe("Movies · 12 files");
    expect(button.querySelector(".library-action")!.textContent).toContain("Open folder");
  });

  it("falls back to the given icon when the library has no picture", async () => {
    await render(<LibraryTile name="Films" meta="Movies" fallback={<HardDrive/>} action={action} onOpen={vi.fn()}/>);
    expect(host.querySelector(".browse-art svg")).not.toBeNull();
    expect(host.querySelector(".browse-art img")).toBeNull();
    expect(host.querySelector(".browse-badge")).toBeNull();
  });

  it("marks an unreachable library and disables its button", async () => {
    await render(<LibraryTile name="Films" meta="Movies" fallback={<HardDrive/>} unreachable enabled={false} action="Turned off" onOpen={vi.fn()}/>);
    expect(host.querySelector("article")!.className).toBe("browse-item library unreachable");
    expect(host.querySelector("button")!.hasAttribute("disabled")).toBe(true);
  });

  it("keeps the shell when a caller supplies its own picture block", async () => {
    const onOpen = vi.fn();
    await render(<LibraryTile name="Remote" meta="Jellyfin · Movies" fallback={<HardDrive/>} path="rlib_1"
      art={<span className="library-preview-collage"/>} action={action} onOpen={onOpen}/>);
    expect(host.querySelector("article")!.className).toBe("browse-item library");
    expect(host.querySelector(".browse-art > .library-preview-collage")).not.toBeNull();
    const button = host.querySelector("button")!;
    await act(async () => { button.click(); await Promise.resolve(); });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
