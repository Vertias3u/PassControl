export const MENU_STATUS_TIMEOUT_MS = 1200;

export async function collectMenuRemoteStatus({
  hasApiKey,
  gatewayStatus,
  request,
  safeText = (value, fallback) => value == null ? fallback : String(value),
}) {
  if (!hasApiKey) {
    return { account: null, gateway: "not authenticated", fleet: "unavailable", kill: "unavailable", current: {} };
  }
  const options = { timeoutMs: MENU_STATUS_TIMEOUT_MS };
  const [gatewayResult, accountResult, fleetResult, killResult] = await Promise.allSettled([
    gatewayStatus(options),
    request("/account", options),
    request("/agents?limit=100", options),
    request("/kill-switch", options),
  ]);
  const gateway = gatewayResult.status === "fulfilled" ? gatewayResult.value.label : "unavailable";
  let account = "unavailable";
  if (accountResult.status === "fulfilled") {
    const email = safeText(accountResult.value?.email, "email unavailable");
    const scope = accountResult.value?.control_key_scope === "write" ? "write key" : "read key";
    account = `${email} · ${scope}`;
  } else if (/^404\b/.test(String(accountResult.reason?.message ?? ""))) {
    account = null;
  }
  let fleet = "unavailable";
  if (fleetResult.status === "fulfilled" && Array.isArray(fleetResult.value)) {
    const records = fleetResult.value;
    const active = records.filter((agent) => agent.status === "active").length;
    const suspended = records.filter((agent) => agent.status === "suspended").length;
    const total = records.length === 100 ? "100+ agents (partial)" : `${records.length} agent${records.length === 1 ? "" : "s"}`;
    fleet = `${total} · ${active} active · ${suspended} suspended`;
  }
  let kill = "unavailable";
  if (killResult.status === "fulfilled") {
    kill = `tenant ${killResult.value?.armed ? "armed" : "clear"} · platform ${killResult.value?.platform_kill ? "armed" : "clear"}`;
  }
  return { account, gateway, fleet, kill, current: { account: account ?? undefined, fleet, kill, gateway } };
}

export const integrationPreviewArgv = (integration) => ["configure", integration];

export function logsArgv({ agentId = "", callClass = "all", status = "", limit = 20 } = {}) {
  return [
    "logs",
    ...(agentId ? ["--agent-id", agentId] : []),
    ...(callClass !== "all" ? ["--class", callClass] : []),
    ...(status ? ["--status", status] : []),
    "--limit", String(limit),
  ];
}

export function verificationArgv({ type, artifact, issuer, audience = "" }) {
  return ["verify", type, artifact, "--issuer", issuer, ...(type === "token" ? ["--audience", audience] : [])];
}

export const agentStateArgv = ({ suspend, id }) => ["agent", suspend ? "suspend" : "resume", id];

export function killSwitchArgv({ armed, typed = "", confirmed = false }) {
  if (armed) return confirmed ? ["kill", "off"] : null;
  return typed === "ARM" ? ["kill", "on"] : null;
}
