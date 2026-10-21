import { createRoot } from "react-dom/client";
import "../style.css";
import "./desktop.css";
import { shellBridge } from "./bridge";
import { previewBridge } from "./preview";
import { i18nReady } from "../i18n";
import { ShellApp } from "./ShellApp";

// No StrictMode: its doubled effects would ask the main process twice for everything.
const bridge = shellBridge() ?? previewBridge(location.search);
const root = document.getElementById("root")!;
if (bridge) {
  document.documentElement.dataset.view = bridge.view;
  void i18nReady.then(() => createRoot(root).render(<ShellApp bridge={bridge}/>));
}
