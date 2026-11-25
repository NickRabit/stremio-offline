import { useEffect, useState } from "react";

// Each keeps at least 6:1 against the light initials, whatever key an addon happens to get.
const COLORS = ["#9a3f30", "#35617c", "#546136", "#754e81", "#79552d", "#32655b", "#695578", "#4b5f6f"];

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
