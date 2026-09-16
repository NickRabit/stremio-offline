import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TrailerPlayer } from "./TrailerPlayer";
import { setLocale } from "./i18n";
import type { Trailer } from "./types";

let root: Root;
let host: HTMLDivElement;

const trailer: Trailer = { youtubeId: "kM8I4yDQS5w", title: "Zkušební trailer", provider: "cinemeta" };

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

const render = (value: Trailer | null, onClose = vi.fn()) => {
  act(() => root.render(<TrailerPlayer trailer={value} onClose={onClose}/>));
  return onClose;
};

const frame = () => host.querySelector("iframe");

it("frames the trailer from its id and nothing else", () => {
  render(trailer);
  expect(frame()!.getAttribute("src")).toBe("https://www.youtube-nocookie.com/embed/kM8I4yDQS5w?autoplay=1&rel=0");
  expect(frame()!.getAttribute("allow")).toBe("autoplay; encrypted-media; picture-in-picture");
  expect(host.textContent).toContain("Zkušební trailer");
});

it("draws nothing without a trailer, or with an id that is not one", () => {
  render(null);
  expect(host.querySelector(".trailer-overlay")).toBeNull();
  render({ ...trailer, youtubeId: "https://www.youtube.com/watch?v=kM8I4yDQS5w" });
  expect(frame()).toBeNull();
});

it("unmounts the frame when the trailer goes away", () => {
  render(trailer);
  expect(frame()).not.toBeNull();
  render(null);
  expect(frame()).toBeNull();
});

it("closes on Escape and on its own button", () => {
  const onClose = render(trailer);
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  expect(onClose).toHaveBeenCalledTimes(1);

  onClose.mockClear();
  const close = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Close trailer"))!;
  act(() => { close.click(); });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("stops listening for Escape once it is closed", () => {
  const onClose = render(trailer);
  render(null);
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  expect(onClose, "the overlay is gone, so the key is not its business").not.toHaveBeenCalled();
});
