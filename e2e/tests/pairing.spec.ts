import { expect, test, type BrowserContext } from "@playwright/test";
import { appUrl } from "../../playwright.config";

test("a signed-in phone approves an independent TV session and a lost poll can replay it", async ({ request, browser, playwright }) => {
  const username = `pair-${Date.now()}`;
  const password = "pair-user-password";
  let phoneContext: BrowserContext | undefined;
  let accountId: string | undefined;
  let tv = await playwright.request.newContext({ baseURL: appUrl, storageState: { cookies: [], origins: [] } });
  try {
    const created = await request.post("/api/users", {
      data: {
        username,
        password,
        role: "user",
        permissions: { downloadToLibrary: false, downloadToDevice: true },
      },
    });
    expect(created.status()).toBe(201);
    const account = await created.json() as { id: string; username: string };
    accountId = account.id;

    phoneContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const phone = await phoneContext.newPage();
    await phone.goto("/");
    const form = phone.locator("form.login-card");
    await form.locator('input[autocomplete="username"]').fill(username);
    await form.locator('input[autocomplete="current-password"]').fill(password);
    await form.locator("button.primary").click();
    await expect(phone.locator("aside.sidebar nav")).toBeVisible();
    expect((await phoneContext.request.patch("/api/settings", { data: { uiLanguage: "en" } })).ok()).toBeTruthy();
    await phone.reload();

    const started = await tv.post("/api/auth/pair/start", { data: { deviceLabel: "E2E Bedroom TV" } });
    expect(started.status()).toBe(201);
    const pairing = await started.json() as { code: string; pollToken: string };

    await phone.getByRole("button", { name: "Settings", exact: true }).click();
    await phone.getByRole("tab", { name: "Account", exact: true }).click();
    await phone.getByRole("button", { name: "Pair a device", exact: true }).click();
    const dialog = phone.getByRole("dialog", { name: "Pair a device" });
    await dialog.getByLabel("Code on the TV").fill(`${pairing.code.slice(0, 4)}-${pairing.code.slice(4)}`);
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(dialog).toContainText("E2E Bedroom TV");
    await expect(dialog).toContainText(account.username);
    await expect(dialog).toContainText(`${pairing.code.slice(0, 4)} ${pairing.code.slice(4)}`);
    await dialog.getByRole("button", { name: "Sign in this device", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(phone.getByText("Device approved. Finish signing in on the TV.")).toBeVisible();

    const delivered = await tv.post("/api/auth/pair/poll", { data: { pollToken: pairing.pollToken } });
    expect(delivered.status()).toBe(200);
    expect(await delivered.json()).toMatchObject({ status: "approved", username });
    const firstCookie = delivered.headers()["set-cookie"];
    expect(firstCookie).toContain("stremio_offline_session=");

    // Simulate a response the TV never saw: after the per-record interval the same poll
    // returns the exact same session instead of rotating it.
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    const replay = await tv.post("/api/auth/pair/poll", { data: { pollToken: pairing.pollToken } });
    expect(replay.status()).toBe(200);
    expect(replay.headers()["set-cookie"]).toBe(firstCookie);

    const tvMe = await tv.get("/api/auth/me");
    expect(tvMe.status()).toBe(200);
    expect(await tvMe.json()).toMatchObject({ username, role: "user" });
    const phoneMe = await phoneContext.request.get("/api/auth/me");
    expect(phoneMe.status()).toBe(200);
    expect(await phoneMe.json()).toMatchObject({ username });

  } finally {
    if (accountId) await request.delete(`/api/users/${accountId}`).catch(() => undefined);
    await tv.dispose().catch(() => undefined);
    await phoneContext?.close().catch(() => undefined);
  }
});
