import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { clearRemoteMosaicCache, RemoteLibraryArt } from "./remote-mosaic";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clearRemoteMosaicCache();
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ posters: ["/a.jpg", "/b.jpg"] }), {
    status: 200, headers: { "content-type": "application/json" },
  })));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearRemoteMosaicCache();
  vi.unstubAllGlobals();
});

it("reveals each fan when its posters were already decoded by another fan", async () => {
  await act(async () => {
    root.render(<>
      <RemoteLibraryArt libraryId="rlib_a" enabled generation={1} target={{ current: host }}/>
      <RemoteLibraryArt libraryId="rlib_b" enabled generation={1} target={{ current: host }}/>
    </>);
    await new Promise((done) => setTimeout(done, 0));
  });
  const fans = host.querySelectorAll(".library-preview-collage");
  expect(fans).toHaveLength(2);
  for (const fan of fans) expect(fan.classList.contains("is-pending")).toBe(true);
  for (const fan of fans) {
    await act(async () => {
      for (const image of fan.querySelectorAll("img")) image.dispatchEvent(new Event("load"));
      await Promise.resolve();
    });
    expect(fan.classList.contains("is-pending")).toBe(false);
  }
  expect(fetch).toHaveBeenCalledTimes(2);
});
