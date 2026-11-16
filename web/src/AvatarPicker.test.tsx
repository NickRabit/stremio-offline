import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api, ApiError } from "./api";
import { AvatarPicker } from "./AvatarPicker";
import { squareAvatar } from "./avatar-image";
import { setLocale } from "./i18n";
import type { Avatar } from "./types";

vi.mock("./avatar-image", async (importOriginal) => ({
  ...await importOriginal<typeof import("./avatar-image")>(),
  squareAvatar: vi.fn(),
}));

let root: Root;
let host: HTMLDivElement;
let presets: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  presets = vi.spyOn(api, "avatarPresets").mockResolvedValue({ presets: ["fox", "cat-face", "owl"] });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const flush = async () => {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
};
const mount = async ({ avatar, allowUpload = false, onPreset = vi.fn().mockResolvedValue(undefined), onUpload = vi.fn().mockResolvedValue(undefined) }: {
  avatar?: Avatar;
  allowUpload?: boolean;
  onPreset?: (id: string | null) => Promise<Avatar | undefined>;
  onUpload?: (image: Blob) => Promise<Avatar | undefined>;
} = {}) => {
  await act(async () => {
    root.render(<AvatarPicker name="Alice" avatar={avatar} allowUpload={allowUpload} onPreset={onPreset} onUpload={onUpload} onClose={vi.fn()}/>);
  });
  await flush();
  return { onPreset, onUpload };
};
const button = (label: string) =>
  document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

describe("AvatarPicker", () => {
  it("shows the preset list and marks the chosen picture", async () => {
    await mount({ avatar: { kind: "preset", id: "fox" } });
    expect(presets).toHaveBeenCalledTimes(1);
    expect(button("fox")?.getAttribute("aria-pressed")).toBe("true");
    expect(button("cat face")?.getAttribute("aria-pressed")).toBe("false");
    expect(button("owl")?.querySelector("img")?.getAttribute("src")).toBe("/avatars/owl.svg");
  });

  it("chooses a preset and the initial at once", async () => {
    const onPreset = vi.fn()
      .mockResolvedValueOnce({ kind: "preset", id: "owl" })
      .mockResolvedValueOnce(undefined);
    await mount({ avatar: { kind: "preset", id: "fox" }, onPreset });

    await act(async () => { button("owl")!.click(); await Promise.resolve(); });
    expect(onPreset).toHaveBeenCalledWith("owl");
    expect(button("owl")?.getAttribute("aria-pressed")).toBe("true");

    const initial = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((entry) => entry.textContent === "Use the initial")!;
    await act(async () => { initial.click(); await Promise.resolve(); });
    expect(onPreset).toHaveBeenLastCalledWith(null);
    expect(initial.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps upload hidden when it is not allowed", async () => {
    await mount();
    expect(document.body.querySelector('input[type="file"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Upload your own");
  });

  it("shows the unreadable message for a file the browser cannot decode", async () => {
    vi.mocked(squareAvatar).mockRejectedValue(new Error("decode"));
    await mount({ allowUpload: true });
    const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["bad"], "bad.png", { type: "image/png" })] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); });
    expect(document.body.textContent).toContain("This browser cannot read that file as a picture.");
  });

  it("shows a server failure in the footer", async () => {
    const onPreset = vi.fn().mockRejectedValue(new ApiError("Too large.", 413, undefined, "err.avatarTooLarge"));
    await mount({ onPreset });
    await act(async () => { button("fox")!.click(); await Promise.resolve(); });
    expect(document.body.querySelector(".dialog-foot .login-error")?.textContent).toBe("The picture is too large.");
  });
});
