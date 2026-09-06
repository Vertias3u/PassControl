#!/usr/bin/env bash
# budget-demo.sh — an agent spends until its budget is gone, then cannot spend.
#
# The claim being demonstrated is NOT "we show you a spend chart". It is that the
# budget is part of the authorization decision: the refusal happens BEFORE the
# provider is contacted, so a blocked call costs nothing and no upstream request
# was ever made with your key.
set -u
GW="${SIDECAR:-http://127.0.0.1:8788}/api/v1/anthropic/v1/messages"
BODY='{"model":"claude-haiku-4-5","max_tokens":16,"messages":[{"role":"user","content":"Name one colour."}]}'

banner() { printf '\n\033[1;33m%s\033[0m\n' "$1"; }

# The CLI's own config, resolved the way the CLI resolves it. PASSPORT_ID is
# what tells us WHICH agent's budget is being spent.
if [ -f .passcontrol ]; then
  set -a; . ./.passcontrol; set +a
elif [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/passcontrol/config" ]; then
  set -a; . "${XDG_CONFIG_HOME:-$HOME/.config}/passcontrol/config"; set +a
fi
GATEWAY="${PASSCONTROL_GATEWAY:-http://localhost:3000}"

# Read from the control plane, matched on THIS passport.
#
# `passcontrol agent list --json` cannot answer this: it reshapes rows to the
# columns of the human table, so `spent_microcents` and `budget_cents` arrive
# undefined and the line reads "$0.000000 spent of no cap" whatever the truth
# is — before AND after the refusal, which would quietly gut the whole demo.
# Matching on the passport also stops [0] reporting a different agent's money.
spent() {
  if [ -z "${PASSCONTROL_API_KEY:-}" ] || [ -z "${PASSPORT_ID:-}" ]; then
    printf '— set PASSCONTROL_API_KEY to read this agent'"'"'s budget'
    return
  fi
  curl -s -H "authorization: Bearer $PASSCONTROL_API_KEY" "$GATEWAY/api/control/v1/agents" |
  PASSPORT_ID="$PASSPORT_ID" node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      try{
        const rows=JSON.parse(d).data??[];
        const a=rows.find(r=>r.passport_pubkey===process.env.PASSPORT_ID);
        if(!a) return console.log("—");
        const usd=(Number(a.spent_microcents??0)/100000000).toFixed(6);
        const cap=a.budget_cents==null?"no cap":"$"+(Number(a.budget_cents)/100).toFixed(2);
        console.log(`$${usd} spent of ${cap}`);
      }catch{console.log("—")}
    })'
}
# The per-call line goes to STDERR and the status code to STDOUT, because the
# caller reads this function through `$(...)`. With both on stdout the substitution
# swallowed every line and the demo played with its middle section blank — the run
# it exists to show simply did not appear.
call() {
  out=$(curl -s -w '\n%{http_code}' "$GW" -H 'content-type: application/json' -d "$BODY")
  code=$(printf '%s' "$out" | tail -1)
  case "$code" in
    200) printf '  %s  agent call → \033[1;32m200 OK\033[0m\n' "$(date +%T)" >&2 ;;
    402|403)
      why=$(printf '%s' "$out" | sed '$d' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).error?.code??"blocked")}catch{console.log("blocked")}})')
      printf '  %s  agent call → \033[1;31m%s %s\033[0m\n' "$(date +%T)" "$code" "$why" >&2 ;;
    *) printf '  %s  agent call → %s\n' "$(date +%T)" "$code" >&2 ;;
  esac
  printf '%s' "$code"
}

clear
banner "the agent's economic authority"
printf '  %s\n' "$(spent)"

banner "agent working — every call reserved against that budget before it leaves"
blocked=0
for _ in 1 2 3 4 5 6 7 8; do
  code=$(call)
  case "$code" in 402|403) blocked=1; break ;; esac
  sleep 0.8
done

if [ "$blocked" = 0 ]; then
  banner "budget not reached — lower this agent's cap in the dashboard and re-run."
  exit 0
fi

banner "refused. and this is the part that matters:"
printf '  %s\n' "$(spent)"
printf '\n  The refusal was decided \033[1mbefore\033[0m the provider was contacted.\n'
printf '  No upstream request was made. The blocked call cost nothing.\n'
printf '  \033[2mBudget is not analytics. Budget is authority.\033[0m\n'
