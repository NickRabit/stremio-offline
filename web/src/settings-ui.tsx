import type { ReactNode } from "react";

export const bytes = (value?: number) => !value ? "—" : value > 1e9 ? `${(value / 1e9).toFixed(1)} GB` : value > 1e6 ? `${(value / 1e6).toFixed(1)} MB` : `${Math.round(value / 1e3)} kB`;

/** Shared by the settings page and the sign-in card, so both look the same. */
export function SettingsSectionHead({ icon, title, text }: { icon: ReactNode; title: string; text?: string }) {
  return <div className="settings-section-head"><i>{icon}</i><span><strong>{title}</strong>{text && <small>{text}</small>}</span></div>;
}

export function SettingControl({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return <label className="setting-control"><span><strong>{title}</strong>{text && <small>{text}</small>}</span>{children}</label>;
}
