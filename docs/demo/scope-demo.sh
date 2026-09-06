#!/usr/bin/env bash
# scope-demo.sh — the same agent, the same key, two models: one allowed, one not.
#
# The point is least privilege on a credential the agent never holds. A provider
# key is all-or-nothing: whoever has it can call anything the account can call.
# Here the agent's authority is narrower than the key's, and the gateway is what
# enforces the difference.
set -u
GW="${SIDECAR:-http://127.0.0.1:8788}/api/v1/anthropic/v1/messages"
ALLOWED="${ALLOWED_MODEL:-claude-haiku-4-5}"
DENIED="${DENIED_MODEL:-claude-opus-4-1}"

banner() { printf '\n\033[1;33m%s\033[0m\n' "$1"; }
try() {
  model="$1"
  body=$(printf '{"model":"%s","max_tokens":16,"messages":[{"role":"user","content":"Name one colour."}]}' "$model")
  out=$(curl -s -w '\n%{http_code}' "$GW" -H 'content-type: application/json' -d "$body")
  code=$(printf '%s' "$out" | tail -1)
  if [ "$code" = 200 ]; then
    printf '  %-22s → \033[1;32m200 OK\033[0m        in scope\n' "$model"
  else
    why=$(printf '%s' "$out" | sed '$d' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).error?.code??"blocked")}catch{console.log("blocked")}})')
    printf '  %-22s → \033[1;31m%s %s\033[0m   refused at the gateway\n' "$model" "$code" "$why"
  fi
}

# The CLI's own config, resolved the way the CLI resolves it: a `.passcontrol`
# in the working directory wins, otherwise the global file. PASSPORT_ID is what
# tells us WHICH agent is about to call.
if [ -f .passcontrol ]; then
  set -a; . ./.passcontrol; set +a
elif [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/passcontrol/config" ]; then
  set -a; . "${XDG_CONFIG_HOME:-$HOME/.config}/passcontrol/config"; set +a
fi
GATEWAY="${PASSCONTROL_GATEWAY:-http://localhost:3000}"

clear
banner "this agent's scope"
# Read from the control plane and matched on THIS passport.
#
# `passcontrol agent list --json` cannot answer this: it reshapes rows to the
# columns of the human table and drops `allowed_scopes` on the way, so the line
# printed "—" whatever the scope was. Taking [0] instead would be worse than
# empty — it would print some other agent's authority next to this agent's
# refusal, which is the one thing this line must never do.
if [ -n "${PASSCONTROL_API_KEY:-}" ] && [ -n "${PASSPORT_ID:-}" ]; then
  curl -s -H "authorization: Bearer $PASSCONTROL_API_KEY" "$GATEWAY/api/control/v1/agents" |
  PASSPORT_ID="$PASSPORT_ID" node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      try{
        const rows=JSON.parse(d).data??[];
        const a=rows.find(r=>r.passport_pubkey===process.env.PASSPORT_ID);
        const s=a?.allowed_scopes;
        console.log("  " + (s ? JSON.stringify(s) : "—"));
      }catch{console.log("  —")}
    })'
else
  printf '  \033[2m— set PASSCONTROL_API_KEY to show the scope this refusal comes from\033[0m\n'
fi

banner "two calls, same agent, same injected provider key"
try "$ALLOWED"
sleep 1.2
try "$DENIED"

banner "why this is not just an allowlist"
printf '  The agent never held the provider key, so it could not have called the\n'
printf '  second model directly even if it tried. The key stays in the vault; the\n'
printf '  gateway injects it only for calls the policy already permitted.\n'
printf '  \033[2mA leaked agent credential cannot exceed the agent.\033[0m\n'
