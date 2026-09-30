import type { Session } from "electron";
import type { StatusFetch } from "./status.js";

/** Electron gives a header value as one string or a list; `Headers` takes one line per name. */
export function responseHeaders(raw: Record<string, string | string[]>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  return headers;
}

/** Probes through a partition, so the cookies a signed-in page left there go
 *  along. A redirect is answered, not followed: the probe reads its location. */
export function sessionFetch(ses: Session): StatusFetch {
  // Electron is imported here rather than at the top, so this module stays loadable without it.
  return async (url, init) => {
    if (init.signal.aborted) throw init.signal.reason;
    const { net } = await import("electron");
    return await new Promise<Response>((resolve, reject) => {
      const request = net.request({ method: "GET", url, session: ses, useSessionCookies: true, redirect: "manual" });
      const settle = (act: () => void) => { init.signal.removeEventListener("abort", onAbort); act(); };
      function onAbort() {
        try { request.abort(); } catch { /* the request may already be gone */ }
        reject(init.signal.reason);
      }
      init.signal.addEventListener("abort", onAbort, { once: true });
      request.on("redirect", (status, _method, _url, headers) => {
        request.abort();
        settle(() => resolve(new Response(null, { status, headers: responseHeaders(headers) })));
      });
      request.on("response", (response) => {
        const status = response.statusCode;
        const headers = responseHeaders(response.headers);
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => { chunks.push(chunk); });
        response.on("end", () => {
          const body = status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks);
          settle(() => resolve(new Response(body, { status, headers })));
        });
      });
      request.on("error", (error) => settle(() => reject(error)));
      request.end();
    });
  };
}
