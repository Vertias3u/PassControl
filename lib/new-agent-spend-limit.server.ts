// Server code only: process.env here is the deployment's, and on the client this
// variable does not exist (it would always read as the $20 default).
import { resolveDefaultDailyLimitCents } from "./new-agent-spend-limit";

/**
 * This deployment's daily limit for a new dashboard agent, in cents, or null when
 * switched off. Read in ONE place, on the server: the forms are handed the value
 * as a prop, so what they prefill is what the server applies.
 */
export function deploymentDefaultDailyLimitCents(): number | null {
  return resolveDefaultDailyLimitCents(process.env.DEFAULT_AGENT_DAILY_LIMIT_USD);
}
