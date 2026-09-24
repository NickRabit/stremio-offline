type MessageKey =
  | "connect.title"
  | "connect.address"
  | "connect.addressHint"
  | "connect.profiles"
  | "connect.profileNew"
  | "connect.profileName"
  | "connect.profileSave"
  | "connect.profileRemove"
  | "connect.profileOption"
  | "connect.profileDiscard"
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
  | "connect.secure"
  | "download.saveTitle"
  | "download.saving"
  | "download.progress"
  | "download.completed"
  | "download.cancelled"
  | "download.interrupted";

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
  desktopDownloadNotice?: (text: string) => void;
  desktopProfileForm: {
    formHasUnsavedEdits(draft: { name: string; origin: string }, snapshot: { name: string; origin: string } | null): boolean;
  };
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
  let busy = false;
  let actionToken = 0;
  let saving: Promise<string | null> | null = null;

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

  const syncControls = () => {
    profileSelect.disabled = busy;
    nameInput.disabled = busy;
    address.disabled = busy;
    saveButton.disabled = busy;
    connectButton.disabled = busy;
    removeButton.disabled = busy || selectedId === null;
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
      option.textContent = catalogue["connect.profileOption"].replace("{name}", profile.name).replace("{origin}", profile.origin);
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
    syncControls();
  };

  const applyIfCurrent = (token: number, state: ProfileState) => {
    if (token === actionToken) applyState(state);
  };

  const runAction = async (action: (token: number) => Promise<void>) => {
    if (busy) return;
    const token = ++actionToken;
    busy = true;
    syncControls();
    try {
      await action(token);
    } finally {
      busy = false;
      syncControls();
    }
  };

  const failureMessage = (reason: "invalid-name" | "invalid-data" | "save-failed"): MessageKey => {
    if (reason === "invalid-name") return "connect.profileInvalidName";
    return reason === "save-failed" ? "connect.profileSaveFailed" : "connect.profileInvalidData";
  };

  const saveForm = (): Promise<string | null> => {
    if (saving) return saving;
    const catalogue = strings;
    if (!catalogue) return Promise.resolve(null);
    saving = (async () => {
      try {
        const result = await window.desktop.saveProfile({ id: selectedId, name: nameInput.value, origin: address.value });
        if (!result.ok) {
          show(catalogue[failureMessage(result.reason)]);
          return null;
        }
        applyState(result);
        return result.selectedProfileId;
      } finally {
        saving = null;
      }
    })();
    return saving;
  };

  window.desktopNotice = (key) => {
    showForm();
    if (strings) show(strings[key]);
  };

  /** The shell sends a finished sentence, because the percentage is formatted there. */
  window.desktopDownloadNotice = (text) => {
    if (typeof text === "string") show(text);
  };

  profileSelect.addEventListener("change", () => {
    void runAction(async (token) => {
      const catalogue = strings;
      if (!catalogue) return;
      const requested = profileSelect.value === "" ? null : profileSelect.value;
      const current = profiles.find((profile) => profile.id === selectedId) ?? null;
      const draft = { name: nameInput.value, origin: address.value };
      if (window.desktopProfileForm.formHasUnsavedEdits(draft, current) && !window.confirm(catalogue["connect.profileDiscard"])) {
        profileSelect.value = selectedId ?? "";
        return;
      }
      const result = await window.desktop.selectProfile(requested);
      if (!result.ok) {
        profileSelect.value = selectedId ?? "";
        show(catalogue[failureMessage(result.reason)]);
        return;
      }
      applyIfCurrent(token, result);
      clear();
    });
  });

  saveButton.addEventListener("click", () => {
    void runAction(async () => {
      if (await saveForm() === null) return;
      clear();
    });
  });

  removeButton.addEventListener("click", () => {
    void runAction(async (token) => {
      const catalogue = strings;
      if (!catalogue || selectedId === null) return;
      const result = await window.desktop.deleteProfile(selectedId);
      if (!result.ok) {
        show(catalogue[failureMessage(result.reason)]);
        return;
      }
      applyIfCurrent(token, result);
      clear();
    });
  });

  connectButton.addEventListener("click", () => {
    void runAction(async () => {
      const catalogue = strings;
      if (!catalogue) return;
      show(catalogue["connect.probing"]);
      const profileId = await saveForm();
      if (profileId === null) return;
      const result = await window.desktop.connect(profileId);
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
  });

  disconnectButton.addEventListener("click", () => {
    void runAction(async () => {
      await window.desktop.disconnect();
      showForm();
    });
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
