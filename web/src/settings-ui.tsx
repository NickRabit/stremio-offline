import type { ReactNode, SyntheticEvent } from "react";

export const bytes = (value?: number) => !value ? "—" : value > 1e9 ? `${(value / 1e9).toFixed(1)} GB` : value > 1e6 ? `${(value / 1e6).toFixed(1)} MB` : `${Math.round(value / 1e3)} kB`;

/** Shared by the settings page and the sign-in card, so both look the same. */
export function SettingsSectionHead({ icon, title, text }: { icon: ReactNode; title: string; text?: string }) {
  return <div className="settings-section-head"><i>{icon}</i><span><strong>{title}</strong>{text && <small>{text}</small>}</span></div>;
}

export function SettingControl({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return <label className="setting-control"><span><strong>{title}</strong>{text && <small>{text}</small>}</span>{children}</label>;
}

/** Artwork comes through the server; when a provider does not deliver, leave the
 *  placeholder underneath rather than a broken image icon. */
export const hideBroken = (event: SyntheticEvent<HTMLImageElement>) => event.currentTarget.classList.add("broken");

export function Heading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return <div className="heading"><small>{eyebrow}</small><h2>{title}</h2></div>;
}
