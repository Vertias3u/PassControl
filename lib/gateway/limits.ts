// Limits shared by every data-plane route.

// Per-agent request-rate cap (independent of the token budget): bounds raw call
// volume so a runaway/abusive agent can't flood the gateway or upstream. Generous
// for normal fleets; tune via env. Returns 429 + Retry-After when exceeded.
//
// ONE counter per agent across LLM and service calls (`proxy:<agentId>`): it is
// a bound on how hard one agent can drive this gateway, whatever it calls.
export const PROXY_RATE_LIMIT = Number(process.env.PROXY_RATE_LIMIT ?? "600");
export const PROXY_RATE_WINDOW_S = Number(process.env.PROXY_RATE_WINDOW_S ?? "60");
