type WebkitVideo = HTMLVideoElement & {
  webkitPresentationMode?: string;
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
};

/** Overlay fullscreen keeps the HTML cue layer. Native cues are only for the
 *  video element's own fullscreen (iOS), where those siblings are not shown. */
export const nativeVideoFullscreen = (video: HTMLVideoElement, overlay: HTMLElement | null) => {
  if (document.fullscreenElement === overlay) return false;
  const webkitVideo = video as HTMLVideoElement & { webkitDisplayingFullscreen?: boolean };
  return document.fullscreenElement === video || Boolean(webkitVideo.webkitDisplayingFullscreen);
};

export function inPictureInPicture(video: HTMLVideoElement): boolean {
  if (document.pictureInPictureElement === video) return true;
  return (video as WebkitVideo).webkitPresentationMode === "picture-in-picture";
}

export function nativeVideoPresentation(video: HTMLVideoElement, overlay: HTMLElement | null): boolean {
  return nativeVideoFullscreen(video, overlay) || inPictureInPicture(video);
}

/** document.pictureInPictureEnabled && !video.disablePictureInPicture, or
 *  typeof video.webkitSupportsPresentationMode === "function" && video.webkitSupportsPresentationMode("picture-in-picture"). */
export function pictureInPictureSupported(video: HTMLVideoElement): boolean {
  if (document.pictureInPictureEnabled && !video.disablePictureInPicture) return true;
  const webkit = video as WebkitVideo;
  return typeof webkit.webkitSupportsPresentationMode === "function" && webkit.webkitSupportsPresentationMode("picture-in-picture");
}

export function exitPictureInPicture(video: HTMLVideoElement): Promise<void> {
  if (document.pictureInPictureElement === video) return document.exitPictureInPicture();
  const webkit = video as WebkitVideo;
  if (webkit.webkitPresentationMode === "picture-in-picture") webkit.webkitSetPresentationMode?.("inline");
  return Promise.resolve();
}

/** Enters when not in PiP, leaves when in it. Standard API first, webkit
 *  presentation mode as the fallback. Returns the promise of the standard call,
 *  or a resolved promise for the webkit path. Must not await before calling the API. */
export function togglePictureInPicture(video: HTMLVideoElement): Promise<void> {
  if (inPictureInPicture(video)) return exitPictureInPicture(video);
  if (typeof video.requestPictureInPicture === "function") {
    return video.requestPictureInPicture().then(() => undefined);
  }
  (video as WebkitVideo).webkitSetPresentationMode?.("picture-in-picture");
  return Promise.resolve();
}
