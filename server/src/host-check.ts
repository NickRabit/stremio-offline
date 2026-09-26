import type { RequestHandler } from "express";

/**
 * DNS rebinding: a page in an ordinary browser can point a name it controls at 127.0.0.1 and then
 * read the loopback server as its own origin. Binding to loopback does not stop that; refusing
 * every `Host` but the loopback one does. The desktop shell turns it on for the backend it
 * manages; a server that is reached by name or from the network leaves it off.
 */
export const loopbackHostCheck = (env: NodeJS.ProcessEnv = process.env): RequestHandler => (req, res, next) => {
  if (env.HOST_CHECK !== "loopback") return next();
  // Read per request: the port is known only after the listener bound it.
  const port = env.PORT;
  const host = req.headers.host?.toLowerCase();
  if (port && (host === `127.0.0.1:${port}` || host === `localhost:${port}`)) return next();
  res.status(421).type("text/plain").send("This server answers only on its loopback address.");
};
