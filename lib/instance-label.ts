/**
 * The name this deployment gives itself on screen.
 *
 * Not a security boundary — it is a human label, and nothing is authorised by
 * it. It exists because one PassControl looks exactly like another: an operator
 * with the local Docker stack, a preview deployment and the hosted cloud open in
 * three tabs needs the sidebar to say which one they are about to arm a kill
 * switch on.
 *
 * Shared rather than inlined because the two shells drifted: the login screen
 * read `PASSCONTROL_INSTANCE_LABEL` while the dashboard sidebar hardcoded
 * "Local control plane" — so the production Control Tower introduced itself as
 * local while the login page in front of it did not. `tests/instance-label.test.ts`
 * fails if either shell grows its own copy of this.
 */
export const DEFAULT_INSTANCE_LABEL = "PassControl control plane";

export function instanceLabel(): string {
  // Blank counts as unset. A whitespace-only value in a dashboard env var is a
  // paste accident, and honouring it would render a nameless chip — strictly
  // worse than the default it was trying to override.
  return process.env.PASSCONTROL_INSTANCE_LABEL?.trim() || DEFAULT_INSTANCE_LABEL;
}
