import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { UserManager } from "./UserManager";
import type { Addon, LibraryView, Session, UserAccount } from "./types";
import { setLocale } from "./i18n";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const admin: Session = { username: "ada", role: "admin" };
const ordinary: Session = { username: "bob", role: "user" };

const account = (over: Partial<UserAccount> = {}): UserAccount => ({
  id: "usr_00000001", username: "ada", role: "admin", disabled: false, mustChangePassword: false,
  createdAt: "2026-01-01T00:00:00.000Z", permissions: { downloadToLibrary: true, downloadToDevice: true },
  libraries: 0, addons: 0, ...over,
});
const library = (over: Partial<LibraryView> = {}): LibraryView => ({
  id: "lib_ab12cd34", name: "Films", type: "movie", root: "/downloads/Films",
  enabled: true, order: 0, addedAt: "2026-09-01T00:00:00.000Z", writeArtwork: true,
  unreachable: false, readOnly: false, defaultMovie: true, defaultSeries: false,
  titles: 12, files: 27, bytes: 48_500_000_000, visibleTo: [], ...over,
});
const addon = (over: Partial<Addon> = {}): Addon => ({
  key: "alpha", role: "source", enabled: true, globalSearch: false,
  manifest: { id: "org.alpha", name: "Alpha", version: "1.0.0" }, allowedUsers: [], ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

/** `onWrite` answers a non-GET call: a Response says what the server said, anything else is
 *  answered as a 200, and `undefined` as an empty object. */
const mount = async ({ session, users, libraries = [], addons = [], onWrite, onError = vi.fn() }:
  { session: Session; users: UserAccount[]; libraries?: LibraryView[]; addons?: Addon[];
    onWrite?: (url: string, body: Record<string, unknown>) => unknown; onError?: (error: unknown) => void }) => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") !== "GET") {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      const answered = onWrite?.(String(url), body);
      if (answered instanceof Response) return answered;
      return answered === undefined ? json({}) : json(answered);
    }
    if (url === "/api/users") return json(users);
    if (url === "/api/libraries") return json(libraries);
    if (url === "/api/addons") return json(addons);
    return json({});
  });
  await act(async () => { root.render(<UserManager session={session} onError={onError} onNotify={vi.fn()}/>); });
  await act(async () => { await Promise.resolve(); });
};

const clickText = async (text: string) => {
  const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);
  expect(button, `"${text}" is on screen`).toBeTruthy();
  await act(async () => { button!.click(); await Promise.resolve(); });
};
/** The dialog is a pane at a time now, so a test that reaches for a grant or a download
 *  switch has to open the pane holding it first. */
const openPane = async (name: string) => {
  const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find((candidate) => candidate.textContent?.trim().startsWith(name));
  expect(tab, `the "${name}" pane is on screen`).toBeTruthy();
  await act(async () => { tab!.click(); await Promise.resolve(); });
};
const clickLabel = async (label: string) => {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button, `"${label}" is on screen`).toBeTruthy();
  await act(async () => { button!.click(); await Promise.resolve(); });
};
const clickBox = async (label: string) => {
  const box = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(box, `"${label}" is on screen`).toBeTruthy();
  await act(async () => { box!.click(); await Promise.resolve(); });
};
const fill = async (label: string, value: string) => {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(input, `"${label}" is on screen`).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input!.dispatchEvent(new Event("input", { bubbles: true })); });
};

it("shows the accounts to an administrator and nothing at all to an ordinary user", async () => {
  await mount({ session: admin, users: [account()] });
  expect(host.querySelectorAll(".user-admin-row")).toHaveLength(1);
  expect(host.textContent).toContain("ada");

  await mount({ session: ordinary, users: [account()] });
  expect(host.textContent, "an ordinary user is not told that accounts exist").toBe("");
});

it("the only enabled administrator cannot lose the role, be switched off or be deleted", async () => {
  await mount({ session: admin, users: [account()] });
  await clickText("Edit");

  expect(host.querySelector<HTMLSelectElement>('select[aria-label="Role"]')?.disabled).toBe(true);
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Enabled"]')?.disabled).toBe(true);
  const remove = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Delete account");
  expect(remove?.disabled).toBe(true);
  expect(host.textContent).toContain("This is the only enabled administrator");
});

it("another enabled administrator unlocks the role, the switch and the delete button", async () => {
  await mount({ session: admin, users: [account({ id: "usr_00000002", username: "bob" }), account()] });
  await clickText("Edit");

  expect(host.querySelector<HTMLSelectElement>('select[aria-label="Role"]')?.disabled).toBe(false);
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Enabled"]')?.disabled).toBe(false);
  const remove = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Delete account");
  expect(remove?.disabled).toBe(false);
});

it("an administrator's row says they see everything instead of counting libraries", async () => {
  await mount({ session: admin, users: [account(), account({ id: "usr_00000002", username: "bob", role: "user", libraries: 2, addons: 3 })] });

  const rows = host.querySelectorAll(".user-admin-row");
  expect(rows[0].textContent).toContain("Sees every library and addon by role.");
  expect(rows[0].textContent, "a count of grants would read as though the role gave none").not.toContain("0 libraries");
  expect(rows[1].textContent).toContain("2 libraries · 3 addons");
});

it("a library tick writes the whole grant list back to the library", async () => {
  const patched: Array<{ url: string; body: Record<string, unknown> }> = [];
  await mount({
    session: admin, users: [account({ id: "usr_00000002", username: "bob", role: "user" }), account()],
    libraries: [library({ visibleTo: ["usr_00000009"] })],
    onWrite: (url, body) => {
      patched.push({ url, body });
      return library({ visibleTo: body.visibleTo as string[] });
    },
  });
  await clickText("Edit");
  await openPane("Libraries");

  expect(host.querySelector<HTMLInputElement>('input[aria-label="Films is visible to this account"]')?.checked).toBe(false);
  await clickBox("Films is visible to this account");
  expect(patched).toEqual([{ url: "/api/libraries/lib_ab12cd34", body: { visibleTo: ["usr_00000009", "usr_00000002"] } }]);

  await clickBox("Films is visible to this account");
  expect(patched[1]).toEqual({ url: "/api/libraries/lib_ab12cd34", body: { visibleTo: ["usr_00000009"] } });
});

it("a disabled addon is still granted, and the tick writes the whole list back", async () => {
  const patched: Array<{ url: string; body: Record<string, unknown> }> = [];
  const rows = [addon({ enabled: false, allowedUsers: [] })];
  await mount({
    session: admin, users: [account({ id: "usr_00000002", username: "bob", role: "user", addons: 0 })],
    addons: rows,
    onWrite: (url, body) => { patched.push({ url, body }); return addon({ allowedUsers: body.allowedUsers as string[] }); },
  });
  await clickText("Edit");
  await openPane("Addons");

  expect(host.textContent, "a switched-off addon still says so").toContain("off");
  await clickBox("Alpha is available to this account");
  expect(patched).toEqual([{ url: "/api/addons/alpha", body: { allowedUsers: ["usr_00000002"] } }]);
});

/** A tick writes to the resource the dialog is not about, so a refusal must not leave the
 *  checkbox looking saved. */
it("a refused grant leaves the checkbox as it was and reports why", async () => {
  const onError = vi.fn();
  await mount({
    session: admin, users: [account({ id: "usr_00000002", username: "bob", role: "user" }), account()],
    libraries: [library({ visibleTo: [] })],
    onError,
    onWrite: () => json({ error: "An administrator already sees every library.", messageKey: "err.adminAlwaysSees" }, 409),
  });
  await clickText("Edit");
  await openPane("Libraries");
  await clickBox("Films is visible to this account");

  expect(onError).toHaveBeenCalledTimes(1);
  expect((onError.mock.calls[0][0] as { status: number }).status).toBe(409);
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Films is visible to this account"]')?.checked).toBe(false);
});

it("the delete confirmation names all three outcomes", async () => {
  const confirmMock = vi.fn((_message?: string) => false);
  vi.stubGlobal("confirm", confirmMock);
  const deleted: string[] = [];
  await mount({
    session: admin,
    users: [account({ id: "usr_00000002", username: "bob", role: "user" }), account()],
    onWrite: (url) => { deleted.push(url); return {}; },
  });
  await clickText("Edit");
  await clickText("Delete account");

  expect(confirmMock).toHaveBeenCalledTimes(1);
  const said = String(confirmMock.mock.calls[0][0]);
  expect(said).toContain("watch history");
  expect(said).toContain("unfinished downloads are cancelled");
  expect(said).toContain("stay in the library");
  expect(deleted, "a cancelled confirmation deletes nothing").toEqual([]);

  confirmMock.mockReturnValue(true);
  await clickText("Delete account");
  expect(deleted).toEqual(["/api/users/usr_00000002"]);
});

it("hides the downloads block from an administrator, and shows it to an ordinary account", async () => {
  await mount({ session: admin, users: [account(), account({ id: "usr_00000002", username: "bob", role: "user" })] });
  await clickText("Edit");
  expect(host.querySelectorAll('[role="tab"]').length, "an administrator has nothing to switch between").toBe(0);
  expect(host.textContent).not.toContain("Download to the library");
  expect(host.textContent).not.toContain("Save to this device");
  expect(host.textContent, "an administrator's libraries are role, not grants").toContain("Sees every library and addon by role.");
  await clickLabel("Close");

  const edits = [...host.querySelectorAll("button")].filter((button) => button.textContent?.trim() === "Edit");
  await act(async () => { edits[1].click(); await Promise.resolve(); });
  // An ordinary account has the pane; an administrator has no tab strip at all.
  await openPane("Downloads");
  expect(host.textContent).toContain("Download to the library");
  expect(host.textContent).toContain("Save to this device");
});

it("the account dialog keeps a new account's name editable and an existing one read-only", async () => {
  await mount({ session: admin, users: [account()] });
  await clickText("Add account");
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Username"]')?.readOnly).toBe(false);
  await clickLabel("Close");

  await clickText("Edit");
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Username"]')?.readOnly).toBe(true);
});

it("creates an account with the role and the download permissions the dialog was set to", async () => {
  const posted: Array<Record<string, unknown>> = [];
  await mount({
    session: admin, users: [account()],
    onWrite: (url, body) => { posted.push({ url, ...body }); return account({ id: "usr_00000005", username: String(body.username) }); },
  });
  await clickText("Add account");
  await fill("Username", "carol");
  await fill("Password", "hunter2");
  await clickText("Create account");

  expect(posted).toEqual([{
    url: "/api/users", username: "carol", password: "hunter2", role: "user",
    permissions: { downloadToLibrary: false, downloadToDevice: true },
  }]);
});
