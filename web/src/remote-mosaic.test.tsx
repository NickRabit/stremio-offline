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
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    posters: ["/a.jpg", "/b.jpg"],
    mosaic: "/api/remote-libraries/rlib_a/mosaic?v=stamp",
  }), { status: 200, headers: { "content-type": "application/json" } })));
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

it("draws the one fan address the server named, at the shape the tile draws", async () => {
  await act(async () => {
    root.render(<>
      <RemoteLibraryArt libraryId="rlib_a" enabled generation={1} target={{ current: host }}/>
      <RemoteLibraryArt libraryId="rlib_b" enabled generation={1} target={{ current: host }}/>
    </>);
    await new Promise((done) => setTimeout(done, 0));
  });
  const drawn = [...host.querySelectorAll("img")].map((image) => image.getAttribute("src"));
  expect(drawn).toEqual([
    "/api/remote-libraries/rlib_a/mosaic?v=stamp&shape=poster",
    "/api/remote-libraries/rlib_a/mosaic?v=stamp&shape=poster",
  ]);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("asks for nothing while mosaics are switched off", async () => {
  await act(async () => {
    root.render(<RemoteLibraryArt libraryId="rlib_a" enabled={false} generation={1} target={{ current: host }}/>);
    await new Promise((done) => setTimeout(done, 0));
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(host.querySelector("img")).toBeNull();
});
