// The pages get this from the shell's preload; the specs only need its type.
import type { ShellBridge } from "../../src/shell-api";

declare global {
  interface Window {
    stremioShell: ShellBridge;
  }
}

export {};
