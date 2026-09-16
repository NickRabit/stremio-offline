import type { Meta } from "./types";

export function mergeMetaDetail(summary: Meta, detail: Meta): Meta {
  return { ...summary, ...detail, id: summary.id, type: summary.type || detail.type, name: summary.name };
}

export function localizedDownloadTitle(summary: Meta, detail: Meta, language: string): string {
  return detail.nameLanguage === language ? detail.name : summary.name;
}
