import type { APIRequestContext, Page } from "@playwright/test";

/** The fixture film is two seconds long, so any saved position past 30s makes the next player
 *  open already at the end and close itself. Tests that play it start from none. */
export const forgetFilm = (request: APIRequestContext) =>
  request.delete(`/api/progress/${encodeURIComponent("movie:tt-e2e-movie")}`);

/** The player also saves its position with a keepalive request as the page goes away. WebKit
 *  does not route that through `page.route`, so a test that mocks progress has to stop it
 *  before it leaves. */
export const withholdUnloadProgress = (page: Page) => page.addInitScript(() => {
  const send = window.fetch.bind(window);
  window.fetch = (input, init) => init?.keepalive && String(input).includes("/api/progress")
    ? Promise.resolve(new Response(null, { status: 204 }))
    : send(input, init);
});
