import { useEffect, useState } from "react";
import type { Avatar as AvatarValue } from "./types";

const AVATAR_COLORS = [
  "#9b3f36",
  "#8a5a2b",
  "#477a48",
  "#2f7474",
  "#3b63a0",
  "#704c9b",
  "#9a3f6e",
  "#666b75",
] as const;

export function avatarColor(name: string): string {
  const value = Array.from(name.trim().toLowerCase()).reduce(
    (hash, character) => Math.imul(hash, 31) + (character.codePointAt(0) ?? 0),
    7,
  );
  return AVATAR_COLORS[Math.abs(value) % AVATAR_COLORS.length]!;
}

export function Avatar({ name, avatar, size = 32, className }: {
  name: string;
  avatar?: AvatarValue;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [avatar]);

  const kind = avatar?.kind === "custom" && failed ? "initial" : avatar?.kind ?? "initial";
  const style = { width: size, height: size };
  const classes = `avatar ${kind}${className ? ` ${className}` : ""}`;
  const initial = name.trim().slice(0, 1).toLocaleUpperCase();

  return <span className={classes} style={style} aria-hidden="true">
    {kind === "custom" && avatar?.kind === "custom"
      ? <img src={avatar.url} alt="" onError={() => setFailed(true)}/>
      : kind === "preset" && avatar?.kind === "preset"
        ? <img src={`/avatars/${avatar.id}.svg`} alt=""/>
        : <span className="avatar-initial" style={{ background: avatarColor(name), fontSize: Math.max(10, Math.round(size * .44)) }}>{initial}</span>}
  </span>;
}
