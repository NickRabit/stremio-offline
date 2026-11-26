export interface FilterTab<V extends string> {
  value: V;
  label: string;
  title?: string;
  disabled?: boolean;
}

/** The underlined tab row every type and source filter shares (catalogue, its search results, search, person). */
export function FilterTabs<V extends string>({ tabs, value, onChange, label, className }: {
  tabs: FilterTab<V>[];
  value: V;
  onChange: (value: V) => void;
  label: string;
  className?: string;
}) {
  return <div className={className ? `filter-tabs ${className}` : "filter-tabs"} role="group" aria-label={label}>
    {tabs.map((tab) => <button key={tab.value} type="button" aria-pressed={tab.value === value}
      disabled={tab.disabled} title={tab.title} onClick={() => { if (tab.value !== value) onChange(tab.value); }}>
      {tab.label}
    </button>)}
  </div>;
}
