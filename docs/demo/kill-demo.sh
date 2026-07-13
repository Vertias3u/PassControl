#!/usr/bin/env bash
# kill-demo.sh — watch a live agent get cut off mid-run, then restored.
set -u
GW="http://127.0.0.1:8788/api/v1/anthropic/v1/messages"
BODY='{"model":"claude-haiku-4-5","max_tokens":5,"messages":[{"role":"user","content":"ok"}]}'
call() {
  code=$(curl -s -o /dev/null -w '%{http_code}' "$GW" \
    -H 'content-type: application/json' -d "$BODY")
  if   [ "$code" = 200 ]; then printf '  %s  agent call → \033[1;32m200 OK\033[0m\n'      "$(date +%T)"
  elif [ "$code" = 403 ]; then printf '  %s  agent call → \033[1;31m403 BLOCKED\033[0m\n' "$(date +%T)"
  else                         printf '  %s  agent call → %s\n' "$(date +%T)" "$code"; fi
}
banner() { printf '\n\033[1;33m%s\033[0m\n' "$1"; }
clear
banner "agent running — governed calls through PassControl"
for _ in 1 2 3; do call; sleep 1.2; done
banner "⛔  operator:  passcontrol kill on"
passcontrol kill on >/dev/null 2>&1
for _ in 1 2 3; do call; sleep 1.2; done
banner "✅  operator:  passcontrol kill off"
passcontrol kill off >/dev/null 2>&1
for _ in 1 2 3; do call; sleep 1.2; done
banner "agent live again."
