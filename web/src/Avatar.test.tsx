import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Avatar, avatarColor } from "./Avatar";
import type { Avatar as AvatarValue } from "./types";

let root: Root;
let host: HTMLDivElement;

const render = (avatar?: AvatarValue, name = " Alice ") => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Avatar name={name} avatar={avatar} size={48}/>));
  return host.querySelector<HTMLElement>(".avatar")!;
};

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Avatar", () => {
  it("draws a custom picture as a cover image", () => {
    const face = render({ kind: "custom", url: "/api/avatar/usr_1?v=2" });
    expect(face.classList.contains("custom")).toBe(true);
    const image = face.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("/api/avatar/usr_1?v=2");
    expect(face.getAttribute("aria-hidden")).toBe("true");
  });

  it("draws a preset from the static avatar directory", () => {
    const face = render({ kind: "preset", id: "fox" });
    expect(face.classList.contains("preset")).toBe(true);
    expect(face.querySelector("img")?.getAttribute("src")).toBe("/avatars/fox.svg");
  });

  it("uses the trimmed name's upper-cased initial on a stable colour", () => {
    const face = render(undefined, " alice ");
    const initial = face.querySelector<HTMLElement>(".avatar-initial")!;
    expect(initial.textContent).toBe("A");
    expect(initial.style.background).not.toBe("");
  });

  it("falls back to the initial when a custom image fails", () => {
    const face = render({ kind: "custom", url: "/broken" });
    act(() => face.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(face.querySelector("img")).toBeNull();
    expect(face.querySelector(".avatar-initial")?.textContent).toBe("A");
  });
});

describe("avatarColor", () => {
  it("is stable for case and surrounding whitespace", () => {
    expect(avatarColor("Alice")).toBe(avatarColor(" alice "));
    expect(avatarColor("Alice")).toBe(avatarColor("Alice"));
  });

  it("spreads names across all eight backgrounds", () => {
    const colors = new Set(Array.from({ length: 80 }, (_, index) => avatarColor(`person-${index}`)));
    expect(colors.size).toBe(8);
  });
});
