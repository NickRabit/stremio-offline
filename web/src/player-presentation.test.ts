import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inPictureInPicture,
  pictureInPictureSupported,
  togglePictureInPicture,
} from "./player-presentation";

type WebkitVideo = HTMLVideoElement & {
  webkitPresentationMode?: string;
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
};

afterEach(() => {
  Reflect.deleteProperty(document, "pictureInPictureEnabled");
  Reflect.deleteProperty(document, "pictureInPictureElement");
  Reflect.deleteProperty(document, "exitPictureInPicture");
  vi.restoreAllMocks();
});

const setEnabled = (value: boolean) => {
  Object.defineProperty(document, "pictureInPictureEnabled", { configurable: true, get: () => value });
};

const setPipElement = (value: Element | null) => {
  Object.defineProperty(document, "pictureInPictureElement", { configurable: true, get: () => value });
};

describe("pictureInPictureSupported", () => {
  it("is true for the standard API when the element allows it", () => {
    setEnabled(true);
    expect(pictureInPictureSupported({ disablePictureInPicture: false } as HTMLVideoElement)).toBe(true);
  });

  it("is true for the webkit-only presentation-mode path", () => {
    setEnabled(false);
    const video = {
      disablePictureInPicture: false,
      webkitSupportsPresentationMode: (mode: string) => mode === "picture-in-picture",
    } as unknown as WebkitVideo;
    expect(pictureInPictureSupported(video)).toBe(true);
  });

  it("is false when the element disables picture in picture and webkit is absent", () => {
    setEnabled(true);
    expect(pictureInPictureSupported({ disablePictureInPicture: true } as HTMLVideoElement)).toBe(false);
  });

  it("is false when neither API is present", () => {
    setEnabled(false);
    expect(pictureInPictureSupported({ disablePictureInPicture: false } as HTMLVideoElement)).toBe(false);
  });
});

describe("inPictureInPicture", () => {
  it("follows document.pictureInPictureElement", () => {
    const video = { disablePictureInPicture: false } as HTMLVideoElement;
    setPipElement(null);
    expect(inPictureInPicture(video)).toBe(false);
    setPipElement(video);
    expect(inPictureInPicture(video)).toBe(true);
  });

  it("follows webkitPresentationMode", () => {
    setPipElement(null);
    const video = { webkitPresentationMode: "picture-in-picture" } as unknown as WebkitVideo;
    expect(inPictureInPicture(video)).toBe(true);
    video.webkitPresentationMode = "inline";
    expect(inPictureInPicture(video)).toBe(false);
  });
});

describe("togglePictureInPicture", () => {
  it("calls requestPictureInPicture when not in picture in picture, before the promise settles", () => {
    setPipElement(null);
    const requestPictureInPicture = vi.fn(() => new Promise<PictureInPictureWindow>(() => {}));
    const video = { requestPictureInPicture } as unknown as HTMLVideoElement;
    const pending = togglePictureInPicture(video);
    expect(requestPictureInPicture).toHaveBeenCalledOnce();
    expect(pending).toBeInstanceOf(Promise);
  });

  it("calls document.exitPictureInPicture when already in it, before the promise settles", () => {
    const video = {} as HTMLVideoElement;
    setPipElement(video);
    const exit = vi.fn(() => new Promise<void>(() => {}));
    Object.defineProperty(document, "exitPictureInPicture", { configurable: true, value: exit });
    const pending = togglePictureInPicture(video);
    expect(exit).toHaveBeenCalledOnce();
    expect(pending).toBeInstanceOf(Promise);
  });

  it("uses webkitSetPresentationMode to enter and leave on the webkit path", async () => {
    setPipElement(null);
    const webkitSetPresentationMode = vi.fn();
    const video = {
      webkitPresentationMode: "inline",
      webkitSetPresentationMode,
    } as unknown as WebkitVideo;
    const entering = togglePictureInPicture(video);
    expect(webkitSetPresentationMode).toHaveBeenCalledWith("picture-in-picture");
    await entering;

    webkitSetPresentationMode.mockClear();
    video.webkitPresentationMode = "picture-in-picture";
    const leaving = togglePictureInPicture(video);
    expect(webkitSetPresentationMode).toHaveBeenCalledWith("inline");
    await leaving;
  });
});
