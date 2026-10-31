// The injection guard's families in plain words, for every view that names one: the
// agent page's findings panel and the public receipt page. An unknown family (a newer
// detector, another deployment's receipt) is shown as itself.
const FAMILY_LABELS: Record<string, string> = {
  instruction_override: "Tells the model to drop its instructions",
  role_markup: "Fake chat or system markup",
  exfil_directive: "Asks for secrets to be sent somewhere",
  authority_claim: "Claims authority over the agent",
  hidden_text: "Hidden from a human reader",
};

/** What a family means in plain words; an unknown one is shown as itself. */
export function familyLabel(family: string): string {
  return Object.hasOwn(FAMILY_LABELS, family) ? FAMILY_LABELS[family]! : family;
}
