import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface ActionMenuItem {
  key: string;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}

export function ActionMenu({ label, title, className, children, items, disabled = false }: {
  label: string;
  title?: string;
  className?: string;
  children: ReactNode;
  items: ActionMenuItem[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, maxHeight: 0 });
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const enabled = items.filter((item) => !item.disabled);
  const focusItem = (index: number) => {
    const buttons = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
    if (!buttons?.length) return;
    buttons[(index + buttons.length) % buttons.length]?.focus();
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const choose = (item: ActionMenuItem) => {
    if (item.disabled) return;
    close(true);
    item.onSelect();
  };

  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const place = () => {
      const anchor = trigger.current!.getBoundingClientRect();
      const width = Math.max(220, menu.current!.getBoundingClientRect().width || 0);
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      const top = Math.min(anchor.bottom + 4, Math.max(12, viewportHeight - 48));
      setPosition({
        top,
        left: Math.max(12, Math.min(anchor.right - width, viewportWidth - width - 12)),
        maxHeight: Math.max(48, viewportHeight - top - 12),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    focusItem(0);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
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

  return <>
    <button ref={trigger} type="button" className={className} aria-haspopup="menu" aria-expanded={open}
      aria-label={label} title={title ?? label} disabled={disabled} onClick={() => setOpen((value) => !value)}>{children}</button>
    {open && createPortal(
      <div ref={menu} className="action-menu" role="menu" aria-label={label}
        style={{ top: position.top, left: position.left, maxHeight: position.maxHeight }}
        onKeyDown={(event) => {
          const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (event.key === "ArrowDown") {
            event.preventDefault();
            focusItem(current + 1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            focusItem(current - 1);
          } else if (event.key === "Home") {
            event.preventDefault();
            focusItem(0);
          } else if (event.key === "End") {
            event.preventDefault();
            focusItem(enabled.length - 1);
          } else if (event.key === "Enter" || event.key === " ") {
            const key = (document.activeElement as HTMLElement | null)?.dataset.itemKey;
            const item = items.find((candidate) => candidate.key === key);
            if (item) {
              event.preventDefault();
              choose(item);
            }
          }
        }}>
        {items.map((item) => <button key={item.key} type="button" role="menuitem" data-item-key={item.key} disabled={item.disabled}
          onClick={() => choose(item)}>{item.label}</button>)}
      </div>, document.body)}
  </>;
}
