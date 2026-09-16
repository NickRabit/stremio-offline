import type { RequestHandler } from "express";

/**
 * Secure mode keeps every third-party byte on the server side: the browser talks
 * only to this instance, so a poster URL never reaches the network the user sits
 * on. It is a setting rather than an environment variable, because it is the kind
 * of thing somebody wants to try both ways without recreating the container.
 */
let current: () => boolean = () => true;

export const configureSecureMode = (read: () => boolean) => { current = read; };
export const secureMode = (): boolean => current();

const POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // Vite inlines the critical style block, and the player sets sizes from script.
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
];

/** Off, the page keeps loading remote artwork the way it always did. */
const imgSrc = () => (secureMode() ? "img-src 'self' data: blob:" : "img-src 'self' data: blob: https: http:");
const frameSrc = () => secureMode() ? undefined : "frame-src 'self' https://www.youtube-nocookie.com";

export const contentSecurityPolicy = (): string => [...POLICY, imgSrc(), frameSrc()].filter((value): value is string => Boolean(value)).join("; ");

/**
 * The policy is the enforcement half of secure mode: rewriting addresses stops the
 * known leaks, this stops the ones nobody thought of.
 */
export const securityHeaders = (): RequestHandler => (_req, res, next) => {
  res.setHeader("content-security-policy", contentSecurityPolicy());
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  next();
};
