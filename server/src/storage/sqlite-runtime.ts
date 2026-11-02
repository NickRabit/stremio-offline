const SQLITE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseSqliteVersion(text: string): [number, number, number] | undefined {
  const match = SQLITE_VERSION.exec(text.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function walSafe([major, minor, patch]: [number, number, number]): boolean {
  if (major !== 3) return major > 3;
  if (minor > 51) return true;
  if (minor === 51) return patch >= 3;
  if (minor === 50) return patch >= 7;
  if (minor === 44) return patch >= 6;
  return false;
}
