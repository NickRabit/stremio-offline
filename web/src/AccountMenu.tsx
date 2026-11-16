import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, KeyRound, Lock, LogOut, Settings as SettingsIcon } from "lucide-react";
import { api } from "./api";
import { Avatar } from "./Avatar";
import { t } from "./i18n";
import type { ProfileEntry, Session } from "./types";

export function AccountMenu({ session, onSwitchTo, onChangeAvatar, onSettings, onSignOut }: {
  session: Session;
  onSwitchTo: (id?: string) => void;
  onChangeAvatar: () => void;
  onSettings?: () => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<ProfileEntry[] | null>(null);
  const [profileFailure, setProfileFailure] = useState(false);
  const [position, setPosition] = useState({ top: 0, right: 8 });
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const box = trigger.current?.getBoundingClientRect();
      if (!box) return;
      setPosition({ top: box.bottom + 8, right: Math.max(8, window.innerWidth - box.right) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (refocus: boolean) => {
      setOpen(false);
      if (refocus) trigger.current?.focus();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(true); };
    const onOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menu.current?.contains(target) || trigger.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onOutside, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onOutside, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !session.canSwitch) return;
    let alive = true;
    setProfiles(null);
    setProfileFailure(false);
    api.profiles()
      .then((answer) => { if (alive) setProfiles(answer.profiles.filter((profile) => !profile.current)); })
      .catch(() => { if (alive) setProfileFailure(true); });
    return () => { alive = false; };
  }, [open, session.canSwitch]);

  const choose = (action: () => void) => {
    setOpen(false);
    trigger.current?.focus();
    action();
  };

  const others = profiles ?? [];
  return <>
    <button
      ref={trigger}
      type="button"
      className="account-trigger"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={t("account.menu")}
      title={session.username}
      onClick={() => {
        if (!open && session.canSwitch) {
          setProfiles(null);
          setProfileFailure(false);
        }
        setOpen((value) => !value);
      }}
    ><Avatar name={session.username} avatar={session.avatar} size={36}/></button>
    {open && createPortal(<div ref={menu} className="account-menu open" role="menu" style={position}>
      <div className="account-menu-head">
        <Avatar name={session.username} avatar={session.avatar} size={44}/>
        <div><strong>{session.username}</strong>{session.role === "admin" && <i className="library-badge">{t("users.administrator")}</i>}</div>
      </div>
      {session.canSwitch && <>
        {(profileFailure || (!profileFailure && profiles !== null && others.length === 0)) &&
          <button type="button" role="menuitem" onClick={() => choose(() => onSwitchTo(undefined))}>
            <span>{t("profiles.switch")}</span>
          </button>}
        {others.map((profile) => <button
          key={profile.id}
          type="button"
          role="menuitem"
          aria-label={t("profiles.switchTo", { name: profile.username })}
          onClick={() => choose(() => onSwitchTo(profile.id))}
        >
          <Avatar name={profile.username} avatar={profile.avatar} size={32}/>
          <span>{profile.username}</span>
          {profile.unlock === "pin" && <Lock aria-label={t("profiles.needsPin")}/>}
          {profile.unlock === "password" && <KeyRound aria-label={t("profiles.needsPassword")}/>}
        </button>)}
      </>}
      <button type="button" role="menuitem" onClick={() => choose(onChangeAvatar)}><Camera/><span>{t("avatar.change")}</span></button>
      {onSettings && <button type="button" role="menuitem" onClick={() => choose(onSettings)}><SettingsIcon/><span>{t("nav.settings")}</span></button>}
      <button type="button" role="menuitem" onClick={() => choose(onSignOut)}><LogOut/><span>{t("app.signOut")}</span></button>
    </div>, document.body)}
  </>;
}
