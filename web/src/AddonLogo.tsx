import { useEffect, useState } from "react";

const COLORS = ["#b84c3a", "#3d6f8e", "#5f6e3d", "#795185", "#966a38", "#3e7c70", "#6d587c", "#4f6575"];

const initials = (name: string): string =>
  name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((word) => [...word][0] ?? "").join("").toLocaleUpperCase();

const colorFor = (addonKey: string): string => {
  let hash = 0;
  for (const character of addonKey) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length]!;
};

export function AddonLogo({ addonKey, name, src }: { addonKey: string; name: string; src?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  if (src && !failed) {
    return <img className="picker-addon-logo" src={src} alt="" aria-hidden="true" onError={() => setFailed(true)}/>;
  }
  return <span className="picker-addon-logo picker-addon-initials" style={{ background: colorFor(addonKey) }} aria-hidden="true">{initials(name)}</span>;
}
