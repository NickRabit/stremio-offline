type MessageKey =
  | "connect.title"
  | "connect.address"
  | "connect.addressHint"
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

interface DesktopBridge {
  bootstrap(): Promise<{ strings: Catalogue; savedOrigin: string | null }>;
  strings: Catalogue;
  savedOrigin: string | null;
  probe(origin: string): Promise<ProbeResult>;
  open(origin: string): Promise<ProbeResult>;
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

  const address = document.getElementById("origin") as HTMLInputElement;
  const message = document.getElementById("message") as HTMLParagraphElement;
  const connectButton = document.getElementById("connect") as HTMLButtonElement;
  const disconnectButton = document.getElementById("disconnect") as HTMLButtonElement;

  let strings: Catalogue | null = null;

  const show = (text: string, extra: string[] = []) => {
    message.replaceChildren(text);
    for (const line of extra) message.append(document.createElement("br"), line);
  };

  const showForm = () => {
    document.body.classList.remove("connected");
    disconnectButton.hidden = true;
  };

  const showConnected = () => {
    document.body.classList.add("connected");
    disconnectButton.hidden = false;
  };

  window.desktopNotice = (key) => {
    showForm();
    if (strings) show(strings[key]);
  };

  connectButton.addEventListener("click", async () => {
    const catalogue = strings;
    if (!catalogue) return;
    show(catalogue["connect.probing"]);
    connectButton.disabled = true;
    const result = await window.desktop.open(address.value);
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
    address.value = state.savedOrigin ?? "";
    showForm();
  };

  void start();
})();
