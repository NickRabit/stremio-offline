import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";
import { classifyClientError, report } from "./diagnostics";
import { i18nReady } from "./i18n";

// An interface error would otherwise land in the browser console, which nobody opens on a TV.
window.addEventListener("error", (event) => {
  const stack = event.error instanceof Error ? event.error.stack : undefined;
  const level = classifyClientError({ message: event.message, filename: event.filename, stack });
  if (level) report(level, `Interface error: ${event.message}`, { source: event.filename, line: event.lineno, column: event.colno, stack });
});
window.addEventListener("unhandledrejection", (event) => {
  const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
  const stack = event.reason instanceof Error ? event.reason.stack : undefined;
  const level = classifyClientError({ message, stack });
  if (level) report(level, `Unhandled rejection: ${message}`, { stack });
});

void i18nReady.then(() => createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>));
