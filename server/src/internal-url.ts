import { INTERNAL_TOKEN } from "./auth.js";

/** A loopback URL for a server-side reader such as FFmpeg; the token stands in for a cookie. */
export function internalUrl(relative: string): string {
  return `http://127.0.0.1:${process.env.PORT ?? 8080}${relative}${relative.includes("?") ? "&" : "?"}token=${INTERNAL_TOKEN}`;
}

export const redactMediaText = (text: string): string => text.replace(/https?:\/\/\S+/g, "<source>");
