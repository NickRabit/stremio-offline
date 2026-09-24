type MessageKey =
  | "connect.title"
  | "connect.address"
  | "connect.addressHint"
  | "connect.profiles"
  | "connect.profileNew"
  | "connect.profileName"
  | "connect.profileSave"
  | "connect.profileRemove"
  | "connect.profileInvalidName"
  | "connect.profileInvalidData"
  | "connect.profileSaveFailed"
  | "connect.connect"
  | "connect.disconnect"
  | "connect.probing"
  | "connect.unreachable"
  | "connect.invalid"
  | "connect.insecure"
  | "connect.notStatus"
  | "connect.version"
  | "connect.restricted"
  | "connect.secure";

type Catalogue = Record<MessageKey, string>;

type ProbeFailure = "invalid" | "insecure-transport" | "unreachable" | "not-status";

type ProbeResult =
  | { ok: true; version: string; restricted: boolean; secure: boolean }
  | { ok: false; reason: ProbeFailure };

interface ServerProfile {
  id: string;
  name: string;
  origin: string;
}

interface ProfileState {
  profiles: ServerProfile[];
  selectedProfileId: string | null;
}

type ProfileResult =
  | ({ ok: true } & ProfileState)
  | { ok: false; reason: "invalid-name" | "invalid-data" | "save-failed" };

interface DesktopBridge {
  bootstrap(): Promise<{ strings: Catalogue } & ProfileState>;
  strings: Catalogue;
  profiles: ServerProfile[];
  selectedProfileId: string | null;
  saveProfile(input: { id: string | null; name: string; origin: string }): Promise<ProfileResult>;
  deleteProfile(id: string): Promise<ProfileResult>;
  selectProfile(id: string | null): Promise<ProfileResult>;
  connect(id: string): Promise<ProbeResult>;
  disconnect(): Promise<void>;
}

interface Window {
  desktop: DesktopBridge;
  desktopNotice?: (key: MessageKey) => void;
}

// The page loads this file as a classic script, so the code stays out of the global scope.
(() => {
  const failureKeys: Record<ProbeFailure, MessageKey> = {
    invalid: "connect.invalid",
    "insecure-transport": "connect.insecure",
    unreachable: "connect.unreachable",
    "not-status": "connect.notStatus",
  };

  const profileSelect = document.getElementById("profiles") as HTMLSelectElement;
  const nameInput = document.getElementById("profileName") as HTMLInputElement;
  const address = document.getElementById("origin") as HTMLInputElement;
  const message = document.getElementById("message") as HTMLParagraphElement;
  const saveButton = document.getElementById("save") as HTMLButtonElement;
  const removeButton = document.getElementById("remove") as HTMLButtonElement;
  const connectButton = document.getElementById("connect") as HTMLButtonElement;
  const disconnectButton = document.getElementById("disconnect") as HTMLButtonElement;

  let strings: Catalogue | null = null;
  let profiles: ServerProfile[] = [];
  let selectedId: string | null = null;

  const show = (text: string, extra: string[] = []) => {
    message.replaceChildren(text);
    for (const line of extra) message.append(document.createElement("br"), line);
  };

  const clear = () => message.replaceChildren();

  const showForm = () => {
    document.body.classList.remove("connected");
    disconnectButton.hidden = true;
  };

  const showConnected = () => {
    document.body.classList.add("connected");
    disconnectButton.hidden = false;
  };

  const renderProfiles = () => {
    const catalogue = strings;
    if (!catalogue) return;
    const options: HTMLOptionElement[] = [];
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = catalogue["connect.profileNew"];
    options.push(blank);
    for (const profile of profiles) {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profile.name;
      options.push(option);
    }
    profileSelect.replaceChildren(...options);
    profileSelect.value = selectedId ?? "";
  };

  const applyState = (state: ProfileState) => {
    profiles = state.profiles;
    selectedId = state.selectedProfileId;
    renderProfiles();
    const profile = profiles.find((entry) => entry.id === selectedId) ?? null;
    nameInput.value = profile?.name ?? "";
    address.value = profile?.origin ?? "";
    removeButton.disabled = profile === null;
  };

  const failureMessage = (reason: "invalid-name" | "invalid-data" | "save-failed"): MessageKey => {
    if (reason === "invalid-name") return "connect.profileInvalidName";
    return reason === "save-failed" ? "connect.profileSaveFailed" : "connect.profileInvalidData";
  };

  // Save first so the connect call only ever names a profile the main process already holds.
  const saveForm = async (): Promise<string | null> => {
    const catalogue = strings;
    if (!catalogue) return null;
    const result = await window.desktop.saveProfile({ id: selectedId, name: nameInput.value, origin: address.value });
    if (!result.ok) {
      show(catalogue[failureMessage(result.reason)]);
      return null;
    }
    applyState(result);
    return result.selectedProfileId;
  };

  window.desktopNotice = (key) => {
    showForm();
    if (strings) show(strings[key]);
  };

  profileSelect.addEventListener("change", async () => {
    const catalogue = strings;
    if (!catalogue) return;
    const result = await window.desktop.selectProfile(profileSelect.value === "" ? null : profileSelect.value);
    if (!result.ok) {
      profileSelect.value = selectedId ?? "";
      show(catalogue[failureMessage(result.reason)]);
      return;
    }
    applyState(result);
    clear();
  });

  saveButton.addEventListener("click", async () => {
    if (await saveForm() === null) return;
    clear();
  });

  removeButton.addEventListener("click", async () => {
    const catalogue = strings;
    if (!catalogue || selectedId === null) return;
    const result = await window.desktop.deleteProfile(selectedId);
    if (!result.ok) {
      show(catalogue[failureMessage(result.reason)]);
      return;
    }
    applyState(result);
    clear();
  });

  connectButton.addEventListener("click", async () => {
    const catalogue = strings;
    if (!catalogue) return;
    show(catalogue["connect.probing"]);
    connectButton.disabled = true;
    const profileId = await saveForm();
    if (profileId === null) {
      connectButton.disabled = false;
      return;
    }
    const result = await window.desktop.connect(profileId);
    connectButton.disabled = false;
    if (!result.ok) {
      showForm();
      show(catalogue[failureKeys[result.reason]]);
      return;
    }
    showConnected();
    const extra: string[] = [];
    if (result.restricted) extra.push(catalogue["connect.restricted"]);
    if (result.secure) extra.push(catalogue["connect.secure"]);
    show(catalogue["connect.version"].replace("{version}", result.version), extra);
  });

  disconnectButton.addEventListener("click", async () => {
    await window.desktop.disconnect();
    showForm();
  });

  const start = async () => {
    const state = await window.desktop.bootstrap();
    strings = state.strings;
    for (const node of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
      node.textContent = state.strings[node.dataset.i18n as MessageKey];
    }
    applyState(state);
    showForm();
  };

  void start();
})();
