#!/usr/bin/env bash
# receipt-demo.sh — a receipt this machine produced, checked by someone who has
# no account here, no credentials, and no reason to trust the dashboard.
#
# This is the demo that separates PassControl from a log. Everyone has logs, and
# every log is only as trustworthy as the party showing it to you. A receipt is
# an Ed25519 signature over what the enforcement layer actually decided, and it
# verifies against a public key set — so the check needs nothing from us.
set -u
banner() { printf '\n\033[1;33m%s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m%s\033[0m\n' "$1"; exit 1; }

# This shell demo reads only this directory's .passcontrol plus exported variables.
# Unlike the CLI, it does not search parent directories or resolve the global profile.
[ -f .passcontrol ] && { set -a; . ./.passcontrol; set +a; }
GATEWAY="${PASSCONTROL_GATEWAY:-http://localhost:3000}"
[ -n "${PASSCONTROL_API_KEY:-}" ] || die "Set PASSCONTROL_API_KEY (or run this from a directory with a .passcontrol file)."

clear
banner "1. an agent makes one governed call"
passcontrol call "Reply with exactly one word." 2>&1 | tail -3

banner "2. the gateway signed a receipt for it"
LOG_ID=$(passcontrol logs --limit 1 --json 2>/dev/null | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    const rows=JSON.parse(d); const r=(Array.isArray(rows)?rows:rows.data??[])[0];
    process.stdout.write(r?.id ?? "");
  })')
[ -n "$LOG_ID" ] || die "No call found in the log."

RESP=$(curl -s -H "authorization: Bearer $PASSCONTROL_API_KEY" "$GATEWAY/api/control/v1/receipts/$LOG_ID")
JWS=$(printf '%s' "$RESP" | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    const r=JSON.parse(d).data??{};
    if(!r.receipt){ console.error("  receipts are not enabled on this instance ("+(r.reason??"no receipt")+")"); process.exit(1); }
    process.stdout.write(r.receipt);
  })') || die "This instance is not signing receipts — check INSTANCE_SIGNING_KEY."
printf '  %s… \033[2m(%s bytes of JWS)\033[0m\n' "$(printf '%s' "$JWS" | cut -c1-56)" "$(printf '%s' "$JWS" | wc -c | tr -d ' ')"

banner "3. now verify it as a stranger would"
printf '  \033[2mno API key, no gateway config — the environment is stripped\033[0m\n\n'
env -u PASSCONTROL_API_KEY -u PASSCONTROL_GATEWAY \
  passcontrol verify receipt "$JWS" --issuer "$GATEWAY" 2>&1 | sed 's/^/  /'

banner "4. and the same receipt with one character changed"
FORGED=$(JWS="$JWS" node -e '
  const j=process.env.JWS, p=j.split(".");
  const s=p[2]; const i=Math.floor(s.length/2);
  const c=s[i]==="A"?"B":"A";
  p[2]=s.slice(0,i)+c+s.slice(i+1);
  process.stdout.write(p.join("."));')
env -u PASSCONTROL_API_KEY -u PASSCONTROL_GATEWAY \
  passcontrol verify receipt "$FORGED" --issuer "$GATEWAY" 2>&1 | sed 's/^/  /'

banner "what this does and does not prove"
printf '  It verifies that the trusted issuer signed this record without alteration.\n'
printf '  The record states identity, decision and reported usage/cost; it does not\n'
printf '  independently prove provider execution, billing or complete logging.\n'
printf '  It carries no prompt or completion body.\n'
printf '  Trust in the issuer is separate from checking its signature.\n'
