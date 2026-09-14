import { expect, test } from "@playwright/test";

const signIn = async (page: import("@playwright/test").Page) => {
  await page.goto("/");
  const form = page.locator("form.login-card");
  await form.getByLabel("Username").fill("restricted-admin");
  await form.getByLabel("Password", { exact: true }).fill("restricted-password");
  await form.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "What do you want to watch?" })).toBeVisible();
};

test.describe("restricted mode", () => {
  test("advertises the lock and refuses configuration writes", async ({ request }) => {
    const status = await request.get("/api/status");
    expect(status.ok()).toBeTruthy();
    expect(await status.json()).toMatchObject({ status: "ok", restricted: true });

    const login = await request.post("/api/auth/login", {
      data: { username: "restricted-admin", password: "restricted-password" },
    });
    expect(login.ok()).toBeTruthy();

    const denied = async (method: "get" | "post" | "patch", url: string, data?: unknown) => {
      const response = await request[method](url, { data });
      expect(response.status(), url).toBe(403);
      expect(await response.json()).toMatchObject({ messageKey: "err.restricted" });
    };

    const addons = await request.get("/api/addons");
    expect(addons.ok()).toBeTruthy();
    const [addon] = await addons.json();
    expect(addon.manifest.name).toBe("E2E doplněk");
    expect(addon.displayUrl).toBeUndefined();
    expect(addon.downloadSettings).toBeUndefined();
    expect(addon.manifestUrl).toBeUndefined();

    await denied("post", "/api/addons", { url: "http://127.0.0.1:8098/manifest.json", role: "both" });
    await denied("post", "/api/addons/refresh");
    await denied("post", `/api/addons/${addon.key}/refresh`);
    await denied("get", `/api/addons/${addon.key}/export`);
    await denied("get", "/api/settings/export");
    await denied("patch", "/api/auth/password", { currentPassword: "restricted-password", newPassword: "other-password" });
    await denied("get", "/api/diagnostics");
    // Both name directories on the host. The library list itself stays readable: a guest
    // sees the names and the counts, never the roots.
    await denied("get", "/api/libraries/browse");
    await denied("get", "/api/libraries/grants");
    await denied("post", "/api/libraries/preview", { root: "/downloads" });
    await denied("post", "/api/libraries/grants", { path: "/downloads" });
    // `create` only ever rides on this route, so the folder-writing path is denied with it.
    await denied("post", "/api/libraries", { name: "New", type: "mixed", root: "/downloads/New", create: true });

    const libraries = await request.get("/api/libraries");
    expect(libraries.ok()).toBeTruthy();
    const [library] = await libraries.json();
    expect(library.name).toBeTruthy();
    expect(library.root).toBeUndefined();
  });

  test("lets a guest browse, play and keeps the admin surface closed", async ({ page }) => {
    await signIn(page);

    await expect(page.locator(".restricted-chip")).toContainText("Demo mode");
    await expect(page.locator(".addon-form")).toHaveCount(0);

    await page.getByRole("button", { name: "Catalog", exact: true }).click();
    const catalog = page.getByRole("combobox", { name: "Browse catalog" });
    await expect(catalog).toBeVisible();
    const labels = await catalog.locator("option").allTextContents();
    const movies = labels.find((text) => /Filmy/.test(text));
    expect(movies).toBeTruthy();
    await catalog.selectOption({ label: movies! });
    await expect(page.getByRole("button", { name: /Zkušební film/ })).toBeVisible();
    await page.getByRole("button", { name: /Zkušební film/ }).click();

    const detail = page.locator(".detail-panel");
    await expect(detail.getByRole("heading", { name: "Zkušební film" })).toBeVisible();
    await expect(detail.getByRole("heading", { name: "Sources" })).toBeVisible();
    await expect(detail.getByRole("button", { name: /E2E 1080p/ })).toBeVisible();
    await detail.getByRole("button", { name: /E2E 1080p/ }).click();
    await expect(detail.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
    await detail.getByRole("button", { name: "Play" }).click();
    await expect(page.locator(".player-overlay")).toBeVisible();
    await page.locator(".player-overlay").getByRole("button", { name: "Close player" }).click();

    await page.getByRole("button", { name: "Addons", exact: true }).click();
    await expect(page.getByText("This instance is in restricted mode.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "E2E doplněk" })).toBeVisible();
    await expect(page.locator(".addon-form")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Interface language" })).toBeDisabled();
    await expect(page.locator("button.diagnostics-toggle")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Change credentials" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign out everywhere" })).toHaveCount(0);
    // The library list is readable, without the controls the API would refuse.
    const manager = page.locator(".library-manager");
    await expect(manager.locator(".library-admin-row")).toHaveCount(1);
    await expect(manager.getByRole("button", { name: "Add library", exact: true })).toHaveCount(0);
    await expect(manager.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0);
  });
});
