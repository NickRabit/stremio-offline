import type { RequestHandler } from "express";

/**
 * DNS rebinding: a page in an ordinary browser can point a name it controls at 127.0.0.1 and then
 * read the loopback server as its own origin. Binding to loopback does not stop that; refusing
 * every `Host` but the loopback one does. The desktop shell turns it on for the backend it
 * manages; a server that is reached by name or from the network leaves it off.
 *
 * `published` widens the accepted `Host` to the loopback pair, an IP literal and the machine's own
 * `.local` names. A rebinding attack needs the attacker's own name in `Host`, and a name they
 * control can be neither an IP literal nor this machine's `.local` name, so the check still holds.
 */
const isIpv4 = (name: string) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(name);

/** Splits a `Host` header into its name and port, unwrapping a bracketed IPv6 literal. */
const splitHost = (host: string): { name: string; port: string; bracketed: boolean } | null => {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1 || !host.slice(end + 1).startsWith(":")) return null;
    return { name: host.slice(1, end), port: host.slice(end + 2), bracketed: true };
  }
  const colon = host.lastIndexOf(":");
  if (colon === -1) return null;
  return { name: host.slice(0, colon), port: host.slice(colon + 1), bracketed: false };
};

const publishedHostNames = (env: NodeJS.ProcessEnv) =>
  new Set((env.HOST_NAMES ?? "").split(",").map((name) => name.trim().toLowerCase()).filter((name) => name.length > 0));

export const loopbackHostCheck = (env: NodeJS.ProcessEnv = process.env): RequestHandler => (req, res, next) => {
  const mode = env.HOST_CHECK;
  if (mode !== "loopback" && mode !== "published") return next();
  // Read per request: the port is known only after the listener bound it.
  const port = env.PORT;
  const host = req.headers.host?.toLowerCase();
  if (port && host) {
    if (mode === "loopback" && (host === `127.0.0.1:${port}` || host === `localhost:${port}`)) return next();
    if (mode === "published") {
      const split = splitHost(host);
      const accepted = split !== null && split.port === port
        && (split.name === "localhost" || isIpv4(split.name) || (split.bracketed && split.name.includes(":")) || publishedHostNames(env).has(split.name));
      if (accepted) return next();
    }
  }
  res.status(421).type("text/plain").send(mode === "published"
    ? "This server answers only on its own addresses."
    : "This server answers only on its loopback address.");
};
