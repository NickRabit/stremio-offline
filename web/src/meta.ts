import type { Meta } from "./types";

export function mergeMetaDetail(summary: Meta, detail: Meta): Meta {
  return { ...summary, ...detail, name: summary.name };
}

export function localizedDownloadTitle(summary: Meta, detail: Meta, language: string): string {
  return detail.nameLanguage === language ? detail.name : summary.name;
}
