import { expect, test, type Page } from "@playwright/test";

/** The fixture addon is not Cinemeta, so a real lookup answers null. What the browser does
 *  with an answer is the point here, so the answer is mocked at the network boundary. */
const TRAILER = { youtubeId: "kM8I4yDQS5w", title: "Zkušební trailer", provider: "cinemeta" };
const EMBED = `https://www.youtube-nocookie.com/embed/${TRAILER.youtubeId}?autoplay=1&rel=0`;
const PILL = ".detail-panel .trailer-action";

const pickCatalog = async (page: Page, pattern: RegExp) => {
  const select = page.getByRole("combobox", { name: "Procházet katalog" });
  const labels = await select.locator("option").allTextContents();
  await select.selectOption({ label: labels.find((text) => pattern.test(text))! });
};

const openMovie = async (page: Page) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  await pickCatalog(page, /Filmy/);
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  await expect(page.locator(".detail-panel").getByRole("heading", { name: "Zkušební film" })).toBeVisible();
};

test("secure mode hands the trailer to YouTube in a new tab and never frames it", async ({ page }) => {
  await page.route("**/api/trailer/**", (route) => route.fulfill({ json: { trailer: TRAILER } }));
  await openMovie(page);

  const pill = page.locator(PILL);
  await expect(pill).toHaveText("TRAILER");
  await expect(pill).toHaveAttribute("href", `https://www.youtube.com/watch?v=${TRAILER.youtubeId}`);
  await expect(pill).toHaveAttribute("target", "_blank");
  await expect(pill).toHaveAttribute("rel", "noopener noreferrer");
  expect(await page.locator("iframe").count(), "nothing third-party enters the page").toBe(0);
});

test("a title with no trailer leaves no pill behind", async ({ page }) => {
  await page.route("**/api/trailer/**", (route) => route.fulfill({ json: { trailer: null } }));
  await openMovie(page);
  await expect(page.locator(PILL)).toHaveCount(0);
});

test("with the instance unlocked the trailer plays in the overlay and leaves the player alone", async ({ page, request }) => {
  await page.route("**/api/trailer/**", (route) => route.fulfill({ json: { trailer: TRAILER } }));
  await request.patch("/api/settings", { data: { secureMode: false } });
  try {
    const document = await page.goto("/");
    expect(document!.headers()["content-security-policy"], "the frame could not load without this").toContain("frame-src 'self' https://www.youtube-nocookie.com");

    await page.getByRole("button", { name: "Katalog", exact: true }).click();
    await pickCatalog(page, /Filmy/);
    await page.getByRole("button", { name: /Zkušební film/ }).click();

    const pill = page.locator(PILL);
    await expect(pill).toHaveText("TRAILER");
    expect(await pill.evaluate((element) => element.tagName), "the unlocked pill opens the overlay itself").toBe("BUTTON");
    await pill.click();

    const overlay = page.locator(".trailer-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay.locator("iframe")).toHaveAttribute("src", EMBED);
    await expect(overlay.locator("iframe")).toHaveAttribute("allow", "autoplay; encrypted-media; picture-in-picture");
    await expect(overlay).toContainText(TRAILER.title);
    expect(await page.locator(".player-overlay").count(), "the film player is not involved").toBe(0);

    await page.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0);
    expect(await page.locator("iframe").count(), "closing unmounts the frame").toBe(0);
  } finally {
    await request.patch("/api/settings", { data: { secureMode: true } });
  }
});

test("an answer that arrives late cannot put a trailer on another title", async ({ page }) => {
  await page.route("**/api/trailer/**", async (route) => {
    if (!route.request().url().includes("movie/tt-e2e-movie")) return route.fulfill({ json: { trailer: null } });
    await new Promise((done) => setTimeout(done, 1500));
    return route.fulfill({ json: { trailer: TRAILER } });
  });
  await openMovie(page);
  await expect(page.locator(PILL), "nothing is drawn while the lookup is in flight").toHaveCount(0);

  await pickCatalog(page, /Seriály/);
  await page.getByRole("button", { name: /Zkušební seriál/ }).click();
  await expect(page.locator(".detail-panel").getByRole("heading", { name: "Zkušební seriál" })).toBeVisible();
  await page.waitForTimeout(1700);
  await expect(page.locator(PILL), "the film's trailer belongs to the film").toHaveCount(0);
});
