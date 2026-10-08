import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LogOut, MoreHorizontal } from "lucide-react";
import { t } from "./i18n";

export interface MoreItem {
  key: string;
  icon: React.ReactNode;
  label: string;
  badge?: number;
  active: boolean;
  onSelect: () => void;
}

/** The compact navigation's overflow slot. The trigger sits among the destinations; the menu
 *  is drawn over the page, so it is portalled out of the sidebar's own button styles. */
export function MoreMenu({ items, badge, active, onSignOut }: { items: MoreItem[]; badge?: number; active: boolean; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);

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
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("click", onOutside, true); };
  }, [open]);

  const choose = (item: MoreItem) => { setOpen(false); trigger.current?.focus(); item.onSelect(); };
  return <>
    <button ref={trigger} className={`nav-more${active ? " active" : ""}`} title={t("nav.more")} aria-label={t("nav.more")} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <MoreHorizontal/><span>{t("nav.more")}</span>{badge ? <b>{badge}</b> : null}
    </button>
    {open && createPortal(
      <div className="more-menu open" role="menu" ref={menu}>
        {items.map((item) => <button key={item.key} role="menuitem" aria-current={item.active ? "page" : undefined} onClick={() => choose(item)}>{item.icon}<span>{item.label}</span>{item.badge ? <b>{item.badge}</b> : null}</button>)}
        <hr/>
        <button role="menuitem" onClick={() => { setOpen(false); trigger.current?.focus(); onSignOut(); }}><LogOut/><span>{t("app.signOut")}</span></button>
      </div>, document.body)}
  </>;
}
