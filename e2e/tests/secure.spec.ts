import { expect, test, type Page } from "@playwright/test";
import { chooseCatalog } from "./catalog-picker";
import { addonManifest, appUrl } from "../../playwright.config";

/** Everything the page may load in secure mode comes from this instance. */
const sameOrigin = (url: string) => url.startsWith(appUrl) || url.startsWith("data:") || url.startsWith("blob:");

const openMovie = async (page: Page) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  await chooseCatalog(page, /Filmy/, "movie");
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  await expect(page.locator(".detail-panel").getByRole("heading", { name: "Zkušební film" })).toBeVisible();
};

test("catalog payloads carry our own links, never the provider's", async ({ request }) => {
  const catalogs = await (await request.get("/api/catalogs")).json();
  const movies = catalogs.find((item: { type: string }) => item.type === "movie");
  const response = await request.get(`/api/catalog?addon=${movies.addonKey}&type=movie&id=${movies.id}`);
  const body = await response.text();
  expect(body).not.toContain("poster.svg");
  expect(body).not.toContain(new URL(addonManifest).host);
  const [first] = JSON.parse(body);
  expect(first.poster).toMatch(/^\/api\/image\/[\w-]{32}$/);

  const image = await request.get(first.poster);
  expect(image.status()).toBe(200);
  expect(image.headers()["content-type"]).toBe("image/svg+xml");

  const meta = await (await request.get(`/api/meta/movie/${first.id}`)).text();
  expect(meta).not.toContain("poster.svg");
});

test("an id the server never handed out fetches nothing", async ({ request }) => {
  expect((await request.get("/api/image/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).status()).toBe(404);
});

test("the page loads a movie without touching a third party", async ({ page }) => {
  const outside: string[] = [];
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (sameOrigin(url)) return route.continue();
    outside.push(url);
    return route.abort();
  });

  await openMovie(page);
  const poster = page.locator(".poster-card img").first();
  await expect(poster).toHaveAttribute("src", /^\/api\/image\//);
  expect(await poster.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  expect(outside).toEqual([]);
});

test("the policy forbids what the rewriting missed", async ({ page }) => {
  const response = await page.goto("/");
  const policy = response!.headers()["content-security-policy"];
  expect(policy).toContain("img-src 'self' data: blob:");
  expect(policy).toContain("default-src 'self'");
  expect(response!.headers()["referrer-policy"]).toBe("no-referrer");
});
