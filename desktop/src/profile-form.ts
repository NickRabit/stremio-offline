interface ProfileDraft {
  name: string;
  origin: string;
}

interface ProfileSnapshot {
  name: string;
  origin: string;
}

const formHasUnsavedEdits = (draft: ProfileDraft, snapshot: ProfileSnapshot | null): boolean => {
  if (snapshot === null) return draft.name.trim() !== "" || draft.origin.trim() !== "";
  return draft.name.trim() !== snapshot.name || draft.origin.trim() !== snapshot.origin;
};

// The connection page is a classic script and cannot import, so the check is published globally.
Object.assign(globalThis, { desktopProfileForm: { formHasUnsavedEdits } });
