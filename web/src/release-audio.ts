/** The audio format a release name advertises, or nothing when it names none.
 *  The most specific codec wins; channels and Atmos are appended when present. */
const CODECS: Array<{ test: RegExp; label: string }> = [
  { test: /dts[\W_]*hd[\W_]*ma|dtshdma/i, label: "DTS-HD MA" },
  { test: /true[\W_]*hd/i, label: "TrueHD" },
  { test: /dts[\W_]*hd/i, label: "DTS-HD" },
  { test: /dd\+|ddp|e-?ac-?3/i, label: "DD+" },
  { test: /(?:^|[^a-z])dts(?:[^a-z]|$)/i, label: "DTS" },
  { test: /ac-?3|(?:^|[^a-z0-9+])dd(?!\+|p)(?=[^a-z]|$)/i, label: "DD" },
  { test: /(?:^|[^a-z])aac(?:[^a-z]|$)/i, label: "AAC" },
  { test: /(?:^|[^a-z])flac(?:[^a-z]|$)/i, label: "FLAC" },
  { test: /(?:^|[^a-z])opus(?:[^a-z]|$)/i, label: "Opus" },
];

const channelLayout = (text: string): string | undefined => {
  for (const layout of ["7.1", "5.1", "2.0"]) {
    const pattern = new RegExp(`(?:^|[^0-9])${layout.replace(".", "\\.")}(?:[^0-9]|$)`);
    if (pattern.test(text)) return layout;
  }
  return undefined;
};

export function audioFormat(text: string | undefined | null): string | undefined {
  const value = text?.trim() ?? "";
  if (!value) return undefined;
  const codec = CODECS.find((entry) => entry.test.test(value))?.label;
  const channels = channelLayout(value);
  const atmos = /(?:^|[^a-z])atmos(?:[^a-z]|$)/i.test(value);
  if (!codec && !atmos) return undefined;
  return [codec, channels, atmos ? "Atmos" : undefined].filter(Boolean).join(" ");
}
