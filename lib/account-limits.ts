// Per-account object limits (migration 0076): turning the database's refusal
// into a sentence.
//
// The database is the only place the limit is enforced; every creation path
// meets its trigger. This module only READS the refusal it raises,
// `account_limit_reached:<kind>:<live|daily>:<limit>`, so each caller can say
// what happened instead of "Something went wrong" or a 500. No imports: the
// dashboard, the control API and the import route all use it.

export type AccountLimitKind = "agents" | "agent_keys" | "credentials" | "api_keys";

export interface AccountLimitRefusal {
  kind: AccountLimitKind;
  /** `live`: too many usable at once. `daily`: too many created in 24 hours. */
  window: "live" | "daily";
  limit: number;
}

const REFUSAL_RE = /account_limit_reached:(agents|agent_keys|credentials|api_keys):(live|daily):(\d+)/u;

export function accountLimitFrom(error: unknown): AccountLimitRefusal | null {
  if (!error || typeof error !== "object") return null;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") return null;
  const match = REFUSAL_RE.exec(message);
  if (!match) return null;
  return {
    kind: match[1] as AccountLimitKind,
    window: match[2] as "live" | "daily",
    limit: Number(match[3]),
  };
}

const NOUN: Record<AccountLimitKind, [one: string, many: string]> = {
  agents: ["agent", "agents"],
  agent_keys: ["agent key", "agent keys"],
  credentials: ["stored credential", "stored credentials"],
  api_keys: ["control-API key", "control-API keys"],
};

function count(limit: number, [one, many]: [string, string]): string {
  return `${limit} ${limit === 1 ? one : many}`;
}

export function accountLimitMessage({ kind, window, limit }: AccountLimitRefusal): string {
  if (window === "daily") {
    return `Too many ${NOUN[kind][1]} were created in the last 24 hours (the limit is ${limit}). Try again later.`;
  }
  switch (kind) {
    case "agents":
      return `This workspace has reached its limit of ${count(limit, NOUN.agents)}. Revoke one you no longer use to add another.`;
    case "agent_keys":
      return `This agent already has ${count(limit, ["active key", "active keys"])}, the most allowed. Revoke one before issuing another.`;
    case "credentials":
      return `This workspace has reached its limit of ${count(limit, NOUN.credentials)}. Delete one you no longer use.`;
    case "api_keys":
      return `This account has ${count(limit, ["active control-API key", "active control-API keys"])}, the most allowed. Each \`passcontrol login\` creates one; revoke old ones in Settings.`;
  }
}
