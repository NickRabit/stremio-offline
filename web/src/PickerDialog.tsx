import { useEffect, useId, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { useDialogFocus } from "./dialog-focus";
import { useDialogViewport } from "./dialog-viewport";
import { t } from "./i18n";

export interface PickerOption {
  key: string;
  label: ReactNode;
  sublabel?: ReactNode;
  tags?: ReactNode;
  icon?: ReactNode;
  selected?: boolean;
  muted?: boolean;
  onChoose: () => void;
}

export interface PickerGroup {
  key: string;
  title: string;
  icon?: ReactNode;
  badge?: ReactNode;
  count?: number;
  note?: string;
  muted?: boolean;
  options: PickerOption[];
}

export interface PickerDialogProps {
  label: string;
  subtitle?: string;
  searchPlaceholder?: string;
  query: string;
  onQuery: (query: string) => void;
  headerExtra?: ReactNode;
  chips?: { title: string; options: PickerOption[] };
  leading?: PickerOption[];
  groups: PickerGroup[];
  rail?: boolean;
  accordion?: boolean;
  openGroup?: string;
  empty?: ReactNode;
  footer?: ReactNode;
  className?: string;
  onClose: () => void;
}

interface Layout {
  narrow: boolean;
  touch: boolean;
}

const media = (query: string): MediaQueryList | null =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null;

const readLayout = (): Layout => {
  const narrow = media("(max-width: 700px), (max-height: 500px)")?.matches ?? false;
  const coarse = media("(pointer: coarse)")?.matches ?? false;
  return {
    narrow,
    touch: (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0) || coarse,
  };
};

const listen = (query: MediaQueryList | null, update: () => void) => {
  if (!query) return () => undefined;
  query.addEventListener?.("change", update);
  query.addListener?.(update);
  return () => {
    query.removeEventListener?.("change", update);
    query.removeListener?.(update);
  };
};

const optionId = (prefix: string, source: string, key: string): string =>
  `picker-${prefix}-${source}-${encodeURIComponent(key)}`;

export function PickerDialog(props: PickerDialogProps): JSX.Element {
  const { label, subtitle, searchPlaceholder, query, onQuery, headerExtra, chips, leading, groups, rail, accordion, openGroup, empty, footer, className, onClose } = props;
  const dialog = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const groupHeaders = useRef(new Map<string, HTMLElement>());
  const idPrefix = useId().replace(/:/g, "");
  const listId = `picker-list-${idPrefix}`;
  const [layout, setLayout] = useState(readLayout);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set(openGroup ? [openGroup] : []));
  const [activeIndex, setActiveIndex] = useState(-1);
  const previousQuery = useRef(query);

  useDialogFocus(dialog);
  useDialogViewport(dialog);

  useEffect(() => {
    const update = () => setLayout(readLayout());
    const removeNarrow = listen(media("(max-width: 700px), (max-height: 500px)"), update);
    const removePointer = listen(media("(pointer: coarse)"), update);
    return () => { removeNarrow(); removePointer(); };
  }, []);

  useEffect(() => {
    if (!layout.narrow && !layout.touch && searchPlaceholder) search.current?.focus({ preventScroll: true });
  }, [layout.narrow, layout.touch, searchPlaceholder]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    setOpenGroups(new Set(openGroup ? [openGroup] : []));
  }, [openGroup]);

  // Opens on the current group, not on whichever addon happens to come first.
  useEffect(() => {
    if (openGroup) groupHeaders.current.get(openGroup)?.scrollIntoView?.({ block: "start" });
  }, []);

  useEffect(() => {
    if (previousQuery.current !== query) setActiveIndex(0);
    previousQuery.current = query;
  }, [query]);

  const accordionActive = Boolean(accordion && layout.narrow && !query.trim());
  const showRail = Boolean(rail && !layout.narrow && !query.trim() && groups.length);
  const open = (group: PickerGroup) => !accordionActive || openGroups.has(group.key);

  const visible = useMemo(() => [
    ...(chips?.options ?? []).map((option) => ({ id: optionId(idPrefix, "chip", option.key), option })),
    ...(leading ?? []).map((option) => ({ id: optionId(idPrefix, "leading", option.key), option })),
    ...groups.flatMap((group) => open(group)
      ? group.options.map((option) => ({ id: optionId(idPrefix, group.key, option.key), option }))
      : []),
  ], [accordion, chips?.options, groups, idPrefix, leading, openGroups, query, layout.narrow]);

  const active = visible[activeIndex];

  useEffect(() => {
    if (active) document.getElementById(active.id)?.scrollIntoView?.({ block: "nearest" });
  }, [active?.id]);

  const move = (delta: number) => {
    if (!visible.length) return;
    setActiveIndex((current) => current < 0
      ? delta > 0 ? 0 : visible.length - 1
      : Math.max(0, Math.min(visible.length - 1, current + delta)));
  };

  const choose = (option: PickerOption) => {
    option.onChoose();
  };

  const option = (item: PickerOption, id: string, chip = false) =>
    <button key={id} id={id} type="button" role="option" aria-selected={Boolean(item.selected)}
      className={`picker-option${chip ? " picker-chip" : ""}${item.muted ? " picker-muted" : ""}${item.selected ? " picker-selected" : ""}`}
      onClick={() => choose(item)}>
      {item.icon && <span className="picker-option-icon">{item.icon}</span>}
      <span className="picker-option-copy">
        <span className="picker-option-label">{item.label}</span>
        {item.sublabel && <span className="picker-option-sublabel">{item.sublabel}</span>}
      </span>
      {item.tags && <span className="picker-option-tags">{item.tags}</span>}
      <span className="picker-option-check" aria-hidden="true">{item.selected && <Check/>}</span>
    </button>;

  const groupHead = (group: PickerGroup) => {
    const content = <>
      {group.icon && <span className="picker-group-icon">{group.icon}</span>}
      <span className="picker-group-title">{group.title}</span>
      {group.badge}
      {typeof group.count === "number" && <span className="picker-group-count">{group.count}</span>}
      {accordionActive && <ChevronDown className="picker-chevron"/>}
    </>;
    const setHead = (node: HTMLElement | null) => {
      if (node) groupHeaders.current.set(group.key, node);
      else groupHeaders.current.delete(group.key);
    };
    return accordionActive
      ? <button ref={setHead} type="button" className="picker-group-head picker-accordion-head"
        aria-expanded={openGroups.has(group.key)} onClick={() => setOpenGroups((current) => {
          const next = new Set(current);
          if (next.has(group.key)) next.delete(group.key);
          else next.add(group.key);
          return next;
        })}>{content}</button>
      : <div ref={setHead} className="picker-group-head">{content}</div>;
  };

  const nothing = !chips?.options.length && !leading?.length && !groups.length;

  return <div ref={dialog} tabIndex={-1} className="identify-overlay" role="dialog" aria-modal="true" aria-label={label}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={`panel identify-card dialog-split picker-card${className ? ` ${className}` : ""}`}>
      <div className="identify-head picker-head">
        <div>
          <h2>{label}</h2>
          {subtitle && <p className="picker-subtitle">{subtitle}</p>}
          {headerExtra && <div className="picker-header-extra">{headerExtra}</div>}
        </div>
        <button type="button" className="icon-button" aria-label={t("common.close")} onClick={onClose}><X/></button>
      </div>
      <div className={`dialog-body picker-body${showRail ? " picker-body-rail" : ""}`}>
        {showRail && <nav className="picker-rail" aria-label={label}>
          {groups.map((group) => <button key={group.key} type="button" className={group.muted ? "picker-muted" : undefined}
            onClick={() => groupHeaders.current.get(group.key)?.scrollIntoView?.({ block: "start" })}>
            {group.icon && <span className="picker-group-icon">{group.icon}</span>}
            <span>{group.title}</span>
            {typeof group.count === "number" && <span className="picker-group-count">{group.count}</span>}
          </button>)}
        </nav>}
        <div className="picker-main">
          {searchPlaceholder && <div className="search-input picker-search">
            <Search/>
            <input ref={search} role="combobox" autoComplete="off" aria-autocomplete="list"
              aria-expanded="true" aria-controls={listId} aria-activedescendant={active?.id}
              aria-label={searchPlaceholder} placeholder={searchPlaceholder} value={query}
              onChange={(event) => { setActiveIndex(0); onQuery(event.target.value); }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  move(event.key === "ArrowDown" ? 1 : -1);
                } else if (event.key === "Enter" && active) {
                  event.preventDefault();
                  choose(active.option);
                }
              }}/>
          </div>}
          <div id={listId} role="listbox" aria-label={label} className="picker-list">
            {chips && chips.options.length > 0 && <section className="picker-chips" role="group" aria-label={chips.title}>
              <div className="picker-section-title">{chips.title}</div>
              <div className="picker-chip-row">{chips.options.map((item) => option(item, optionId(idPrefix, "chip", item.key), true))}</div>
            </section>}
            {leading && leading.length > 0 && <div className="picker-leading">
              {leading.map((item) => option(item, optionId(idPrefix, "leading", item.key)))}
            </div>}
            {groups.map((group) => <section key={group.key} role="group" aria-label={group.title}
              className={`picker-group${group.muted ? " picker-muted" : ""}`}>
              {groupHead(group)}
              {open(group) && <>
                <div className="picker-group-options">{group.options.map((item) => option(item, optionId(idPrefix, group.key, item.key)))}</div>
                {group.note && <p className="picker-group-note">{group.note}</p>}
              </>}
            </section>)}
            {nothing && <div className="picker-empty">{empty}</div>}
          </div>
        </div>
      </div>
      {footer && <footer className="dialog-foot">{footer}</footer>}
    </div>
  </div>;
}
