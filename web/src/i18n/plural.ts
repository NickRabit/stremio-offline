export interface PluralForms { one: string; few?: string; many?: string; other: string }

/** Use the browser's CLDR plural rules and fall back when a catalogue has no form
 *  for a category. */
export function pluralForm(locale: string, count: number, forms: PluralForms): string {
  const category = new Intl.PluralRules(locale).select(count) as keyof PluralForms;
  return forms[category] ?? forms.other;
}
