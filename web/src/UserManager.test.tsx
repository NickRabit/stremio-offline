import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { UserManager } from "./UserManager";
import type { Addon, AdminRemoteLibrary, LibraryView, Session, UserAccount } from "./types";
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
  enabled: true, order: 0, addedAt: "2026-09-01T00:00:00.000Z", writeArtwork: true, autoScanMetadata: true,
  unreachable: false, readOnly: false, writable: true, defaultMovie: true, defaultSeries: false,
  titles: 12, files: 27, bytes: 48_500_000_000, visibleTo: [], ...over,
});
const addon = (over: Partial<Addon> = {}): Addon => ({
  key: "alpha", role: "source", enabled: true, globalSearch: false,
  manifest: { id: "org.alpha", name: "Alpha", version: "1.0.0" }, allowedUsers: [], ...over,
});
const remoteLibrary = (over: Partial<AdminRemoteLibrary> = {}): AdminRemoteLibrary => ({
  id: "rlib_a", connectionId: "mconn_1", remoteId: "lib1", name: "Remote clips", type: "movie",
  enabled: true, order: 0, showOnHome: true, showInContinueWatching: true, allowedUsers: [], provider: "jellyfin", ...over,
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
const flush = async () => { await act(async () => { await new Promise((done) => setTimeout(done, 0)); }); };
const mount = async ({ session, users, libraries = [], remoteLibraries = [], addons = [], failRemote = false, restricted = false, onWrite, onError = vi.fn() }:
  { session: Session; users: UserAccount[]; libraries?: LibraryView[]; remoteLibraries?: AdminRemoteLibrary[]; addons?: Addon[];
    failRemote?: boolean; restricted?: boolean; onWrite?: (url: string, body: Record<string, unknown>) => unknown; onError?: (error: unknown) => void }) => {
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
    if (url === "/api/media-servers/libraries") {
      if (failRemote) return json({ error: "The media servers could not be read.", messageKey: "err.mediaServerUnavailable" }, 502);
      return json({ libraries: remoteLibraries });
    }
    return json({});
  });
  await act(async () => { root.render(<UserManager session={session} restricted={restricted} onError={onError} onNotify={vi.fn()}/>); });
  await flush();
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

it("a demoted account gets its grant panes back with the ticks it had", async () => {
  const bob = account({ id: "usr_00000002", username: "bob", role: "admin" });
  await mount({
    session: admin, users: [bob, account()],
    libraries: [library({ visibleTo: ["usr_00000002"] })],
    addons: [addon({ allowedUsers: ["usr_00000002"] })],
    onWrite: () => account({ id: "usr_00000002", username: "bob", role: "user", libraries: 1, addons: 1 }),
  });
  await clickText("Edit");
  expect(host.textContent, "an administrator has no grant panes").toContain("Sees every library and addon by role.");

  const role = host.querySelector<HTMLSelectElement>('select[aria-label="Role"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => { setter.call(role, "user"); role.dispatchEvent(new Event("change", { bubbles: true })); });

  // The grants were never swept, so the panes come back reading what they read before the
  // promotion: the administrator has nothing to rebuild by hand.
  await openPane("Libraries");
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Films is visible to this account"]')?.checked).toBe(true);
  await openPane("Addons");
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Alpha is available to this account"]')?.checked).toBe(true);
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

const choose = async (label: string, value: string) => {
  const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  expect(select, `"${label}" is on screen`).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => { setter.call(select, value); select!.dispatchEvent(new Event("change", { bubbles: true })); });
};

it("an ordinary user makes no administrator read at all", async () => {
  await mount({ session: ordinary, users: [account()], remoteLibraries: [remoteLibrary()] });
  expect(fetchMock, "not even the grant lists, which the server would refuse").not.toHaveBeenCalled();
});

it("a failed grant-list read is reported and keeps account creation disabled", async () => {
  const onError = vi.fn();
  await mount({ session: admin, users: [account()], failRemote: true, onError });

  expect(onError).toHaveBeenCalledTimes(1);
  const add = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Add account");
  expect(add?.disabled, "a create dialog without the remote list would grant blind").toBe(true);
  expect(host.textContent, "a failed read is not shown as an empty remote list").not.toContain("Remote libraries");
});

it("a restricted instance lists the accounts without reading the refused remote inventory", async () => {
  const onError = vi.fn();
  await mount({ session: admin, users: [account()], restricted: true, onError });

  expect(host.querySelectorAll(".user-admin-row")).toHaveLength(1);
  expect(onError).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain("/api/media-servers/libraries");
});

it("shows local and remote libraries in one Libraries pane, counted together", async () => {
  await mount({
    session: admin,
    users: [account({ id: "usr_00000002", username: "bob", role: "user", libraries: 1, addons: 0, remoteLibraries: 2 }), account()],
    libraries: [library({ name: "Films" })],
    remoteLibraries: [
      remoteLibrary({ id: "rlib_a", name: "Remote clips", provider: "jellyfin" }),
      remoteLibrary({ id: "rlib_b", name: "Other shelf", provider: "emby", enabled: false }),
    ],
  });
  const row = [...host.querySelectorAll(".user-admin-row")].find((node) => node.textContent?.includes("bob"))!;
  expect(row.querySelector(".library-admin-counts")?.textContent).toContain("3 libraries · 0 addons");

  await clickText("Edit");
  expect(host.querySelector("#user-tab-libraries")?.textContent, "the tab counts local and remote").toContain("3");
  await openPane("Libraries");
  expect(host.textContent).toContain("Remote libraries");
  const labels = [...host.querySelectorAll<HTMLInputElement>(".user-grant-list input[type=checkbox]")].map((box) => box.getAttribute("aria-label"));
  expect(labels).toEqual([
    "Films is visible to this account",
    "Remote clips (Jellyfin) is visible to this account",
    "Other shelf (Emby) is visible to this account",
  ]);
  expect(host.textContent, "each remote row carries its provider and type").toContain("Jellyfin");
  expect(host.textContent).toContain("Emby");
  expect(host.textContent).toContain("Turned off");
});

it("tells two libraries apart when they share a name on different providers", async () => {
  await mount({
    session: admin,
    users: [account({ id: "usr_00000002", username: "bob", role: "user" }), account()],
    libraries: [library({ name: "Films" })],
    remoteLibraries: [remoteLibrary({ id: "rlib_a", name: "Films", provider: "jellyfin" })],
  });
  await clickText("Edit");
  await openPane("Libraries");
  expect(host.querySelector('input[aria-label="Films is visible to this account"]')).not.toBeNull();
  expect(host.querySelector('input[aria-label="Films (Jellyfin) is visible to this account"]')).not.toBeNull();
});

it("a remote tick writes the whole grant list back, keeping every other account", async () => {
  const patched: Array<{ url: string; body: Record<string, unknown> }> = [];
  await mount({
    session: admin,
    users: [account({ id: "usr_00000002", username: "bob", role: "user" }), account()],
    remoteLibraries: [remoteLibrary({ id: "rlib_a", name: "Remote clips", allowedUsers: ["usr_00000009"] })],
    onWrite: (url, body) => {
      patched.push({ url, body });
      return remoteLibrary({ id: "rlib_a", name: "Remote clips", allowedUsers: body.allowedUsers as string[] });
    },
  });
  await clickText("Edit");
  await openPane("Libraries");

  expect(host.querySelector<HTMLInputElement>('input[aria-label="Remote clips (Jellyfin) is visible to this account"]')?.checked).toBe(false);
  await clickBox("Remote clips (Jellyfin) is visible to this account");
  expect(patched).toEqual([{ url: "/api/remote-libraries/rlib_a", body: { allowedUsers: ["usr_00000009", "usr_00000002"] } }]);
  expect(host.querySelector(".user-admin-row .library-admin-counts")?.textContent).toContain("1 libraries");

  await clickBox("Remote clips (Jellyfin) is visible to this account");
  expect(patched[1]).toEqual({ url: "/api/remote-libraries/rlib_a", body: { allowedUsers: ["usr_00000009"] } });
  expect(host.querySelector(".user-admin-row .library-admin-counts")?.textContent).toContain("0 libraries");
});

it("a refused remote grant leaves the checkbox at the value the server kept", async () => {
  const onError = vi.fn();
  await mount({
    session: admin,
    users: [account({ id: "usr_00000002", username: "bob", role: "user" }), account()],
    remoteLibraries: [remoteLibrary({ id: "rlib_a", name: "Remote clips", allowedUsers: [] })],
    onError,
    onWrite: () => json({ error: "An administrator already sees every library.", messageKey: "err.adminAlwaysSees" }, 409),
  });
  await clickText("Edit");
  await openPane("Libraries");
  await clickBox("Remote clips (Jellyfin) is visible to this account");

  expect(onError).toHaveBeenCalledTimes(1);
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Remote clips (Jellyfin) is visible to this account"]')?.checked).toBe(false);
});

/** A new account starts with everything switched on ticked and everything switched off clear,
 *  for the remote list exactly as for the local one, and both can be overridden by hand. */
it("a new account ticks the enabled remote libraries and can override that", async () => {
  const patched: Array<{ url: string; body: Record<string, unknown> }> = [];
  const users = [account()];
  await mount({
    session: admin, users,
    remoteLibraries: [
      remoteLibrary({ id: "rlib_on", name: "Movie shelf" }),
      remoteLibrary({ id: "rlib_off", name: "Off shelf", enabled: false }),
    ],
    onWrite: (url, body) => {
      if (url === "/api/users") { const made = account({ id: "usr_00000005", username: String(body.username), role: "user" }); users.push(made); return made; }
      patched.push({ url, body });
      return remoteLibrary({ id: url.split("/").pop()!, allowedUsers: body.allowedUsers as string[] });
    },
  });
  await clickText("Add account");
  await fill("Username", "carol");
  await fill("Password", "hunter2");
  await openPane("Libraries");

  expect(host.querySelector<HTMLInputElement>('input[aria-label="Movie shelf (Jellyfin) is visible to this account"]')?.checked).toBe(true);
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Off shelf (Jellyfin) is visible to this account"]')?.checked).toBe(false);
  await clickBox("Movie shelf (Jellyfin) is visible to this account");
  await clickBox("Off shelf (Jellyfin) is visible to this account");
  // The create button lives on the account pane; the overrides are held by the dialog, so
  // stepping back to it keeps them.
  await openPane("Account");
  await clickText("Create account");

  expect(patched).toEqual([{ url: "/api/remote-libraries/rlib_off", body: { allowedUsers: ["usr_00000005"] } }]);
});

it("creates an administrator without any grant writes", async () => {
  const patched: Array<{ url: string; body: Record<string, unknown> }> = [];
  const users = [account()];
  await mount({
    session: admin, users,
    remoteLibraries: [remoteLibrary({ id: "rlib_a", name: "Remote clips" })],
    onWrite: (url, body) => {
      if (url === "/api/users") { const made = account({ id: "usr_00000005", username: String(body.username), role: "admin" }); users.push(made); return made; }
      patched.push({ url, body });
      return {};
    },
  });
  await clickText("Add account");
  await fill("Username", "root");
  await fill("Password", "hunter2");
  await choose("Role", "admin");
  await clickText("Create account");

  expect(patched, "the role already reaches everything, so nothing is written").toEqual([]);
});

it("a grant that fails after creation opens the account instead of creating it twice", async () => {
  const onError = vi.fn();
  const posts: string[] = [];
  const users = [account()];
  const libraries = [library({ id: "lib_ab12cd34", name: "Films", visibleTo: [] })];
  const remoteLibraries = [remoteLibrary({ id: "rlib_a", name: "Remote clips", allowedUsers: [] })];
  await mount({
    session: admin, users, libraries, remoteLibraries, onError,
    onWrite: (url, body) => {
      if (url === "/api/users") {
        posts.push(url);
        const made = account({ id: "usr_00000005", username: String(body.username), role: "user", libraries: 0, addons: 0, remoteLibraries: 1 });
        users.push(made);
        return made;
      }
      if (url === "/api/libraries/lib_ab12cd34") return json({ error: "An administrator already sees every library.", messageKey: "err.adminAlwaysSees" }, 409);
      if (url === "/api/remote-libraries/rlib_a") {
        remoteLibraries[0] = remoteLibrary({ id: "rlib_a", name: "Remote clips", allowedUsers: body.allowedUsers as string[] });
        return remoteLibraries[0];
      }
      return {};
    },
  });
  await clickText("Add account");
  await fill("Username", "carol");
  await fill("Password", "hunter2");
  await clickText("Create account");

  expect(posts, "the account is made once, whatever the grants do").toEqual(["/api/users"]);
  expect(onError).toHaveBeenCalledTimes(1);
  expect([...host.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Create account"),
    "the dialog edits the account that exists, so it cannot be created again").toBe(false);
  expect(host.querySelector(".identify-head h2")?.textContent).toBe("carol");
  await openPane("Libraries");
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Remote clips (Jellyfin) is visible to this account"]')?.checked,
    "the grant that landed is shown").toBe(true);
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Films is visible to this account"]')?.checked,
    "the grant that was refused stays where the server left it").toBe(false);
});
