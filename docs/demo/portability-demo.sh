#!/usr/bin/env bash
# portability-demo.sh — one agent, one policy, two completely different clients.
#
# The objection this answers is "so I have to rewrite my agent". No: anything
# that takes a base URL is already compatible. The CLI and a raw OpenAI-shaped
# HTTP client are about as different as two callers get, and the gateway
# attributes both to the same passport under the same policy.
#
# Set HERMES=1 to run your real Hermes task as the second client instead of curl:
#   passcontrol env hermes --provider anthropic --model claude-haiku-4-5
set -u
SIDECAR="${SIDECAR:-http://127.0.0.1:8788}"
banner() { printf '\n\033[1;33m%s\033[0m\n' "$1"; }

clear
banner "client 1 — the PassControl CLI"
passcontrol call "Reply with exactly one word." 2>&1 | tail -3

banner "client 2 — a plain HTTP client that has never heard of PassControl"
printf '  \033[2mPOST %s/api/v1/anthropic/v1/messages\033[0m\n' "$SIDECAR"
printf '  \033[2mauthorization: none. the sidecar attaches a short-lived visa.\033[0m\n'
code=$(curl -s -o /dev/null -w '%{http_code}' \
  "$SIDECAR/api/v1/anthropic/v1/messages" -H 'content-type: application/json' \
  -d '{"model":"claude-haiku-4-5","max_tokens":16,"messages":[{"role":"user","content":"Name one colour."}]}')
if [ "$code" = 200 ]; then printf '  → \033[1;32m200 OK\033[0m\n'; else printf '  → \033[1;31m%s\033[0m\n' "$code"; fi

banner "both calls, as the gateway recorded them"
passcontrol logs --limit 2 --json 2>/dev/null | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    const rows=JSON.parse(d); const list=(Array.isArray(rows)?rows:rows.data??[]);
    for(const r of list.slice(0,2).reverse()){
      const usd=r.cost_microcents == null ? "unknown" : "$"+(Number(r.cost_microcents)/100000000).toFixed(6);
      console.log(`  agent ${String(r.agent_id).slice(0,8)}  ${String(r.provider).padEnd(10)} ${String(r.model).padEnd(20)} ${String(r.status).padEnd(9)} ${usd}`);
    }
    const ids=new Set(list.slice(0,2).map(r=>r.agent_id));
    console.log("");
    console.log(ids.size===1
      ? "  \x1b[1mSame agent id on both rows.\x1b[0m Two clients, one identity, one policy."
      : "  (different agents — point both clients at the same passport to see this)");
  })'

banner "what did not have to change"
printf '  No SDK was swapped. No key was copied into a config file. The second\n'
printf '  client sent no credential at all — the sidecar minted a short-lived visa\n'
printf '  for it. Point a base URL at the gateway and the governance is already on.\n'
