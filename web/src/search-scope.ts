export interface SearchScope {
  addonKey?: string;
  catalogType?: string;
  catalogId?: string;
}

export function parseSearchScope(value: string): SearchScope {
  if (value.startsWith("addon:")) return { addonKey: value.slice("addon:".length) || undefined };
  if (!value.startsWith("catalog:")) return {};
  const rest = value.slice("catalog:".length);
  const addonEnd = rest.indexOf(":");
  const typeEnd = rest.indexOf(":", addonEnd + 1);
  if (addonEnd < 1 || typeEnd <= addonEnd + 1) return {};
  const catalogId = rest.slice(typeEnd + 1);
  if (!catalogId) return {};
  return { addonKey: rest.slice(0, addonEnd), catalogType: rest.slice(addonEnd + 1, typeEnd), catalogId };
}
