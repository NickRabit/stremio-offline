import assert from "node:assert/strict";
import test from "node:test";
import "./profile-form.js";

type FormHasUnsavedEdits = (
  draft: { name: string; origin: string },
  snapshot: { name: string; origin: string } | null,
) => boolean;

const { formHasUnsavedEdits } = (globalThis as unknown as {
  desktopProfileForm: { formHasUnsavedEdits: FormHasUnsavedEdits };
}).desktopProfileForm;

const saved = { name: "Attic", origin: "https://attic.example" };

test("a form that matches the selected profile has nothing to discard", () => {
  assert.equal(formHasUnsavedEdits({ name: "Attic", origin: "https://attic.example" }, saved), false);
  assert.equal(formHasUnsavedEdits({ name: " Attic ", origin: " https://attic.example " }, saved), false);
});

test("a changed name or a changed origin is unsaved work", () => {
  assert.equal(formHasUnsavedEdits({ name: "Other", origin: "https://attic.example" }, saved), true);
  assert.equal(formHasUnsavedEdits({ name: "Attic", origin: "https://other.example" }, saved), true);
  assert.equal(formHasUnsavedEdits({ name: "Attic", origin: "" }, saved), true);
});

test("an empty new profile is not dirty but a typed one is", () => {
  assert.equal(formHasUnsavedEdits({ name: "", origin: "" }, null), false);
  assert.equal(formHasUnsavedEdits({ name: "  ", origin: " " }, null), false);
  assert.equal(formHasUnsavedEdits({ name: "New", origin: "" }, null), true);
  assert.equal(formHasUnsavedEdits({ name: "", origin: "http://192.168.1.20:8090" }, null), true);
});
