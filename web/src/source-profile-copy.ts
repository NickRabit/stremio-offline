/** Built-in profile names the interface already translates. A variant has no entry here. */
export const SOURCE_PROFILE_COPY = {
  "sourceProfile.recommended": { name: "sourceProfile.recommended" },
  "sourceProfile.providerPriority": { name: "sourceProfile.providerPriority", hint: "sourceProfile.providerPriorityHint" },
  "sourceProfile.travel": { name: "sourceProfile.travel", hint: "sourceProfile.travelHint" },
} as const;

export type SourceProfileNameKey = keyof typeof SOURCE_PROFILE_COPY;

export function sourceProfileCopy(key: SourceProfileNameKey): (typeof SOURCE_PROFILE_COPY)[SourceProfileNameKey];
export function sourceProfileCopy(key: string | undefined): (typeof SOURCE_PROFILE_COPY)[SourceProfileNameKey] | undefined;
export function sourceProfileCopy(key: string | undefined) {
  if (key !== undefined && Object.hasOwn(SOURCE_PROFILE_COPY, key)) {
    return SOURCE_PROFILE_COPY[key as SourceProfileNameKey];
  }
  return undefined;
}
