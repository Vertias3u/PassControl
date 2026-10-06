#!/usr/bin/env bash
# One-command local stack: Supabase (CLI) + Redis/SRH (compose) + migrate + seed.
# Packaging only — no gateway code changes.
#
#   bash scripts/dev-stack.sh          (or: npm run dev:stack)
#
# Prereqs: Docker running + the Supabase CLI. NO host psql needed — migrations run
# inside the Supabase DB container. Afterwards, start the app with the docker env:
#   npm run dev:docker
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SRC"
ENVF="$SRC/.env.docker"
# `passcontrol update` sets this: it prints its own progress, so the script keeps
# Supabase's banner (local keys included) and per-migration "already applied"
# lines to itself, and shows Supabase's full output only if starting it fails.
QUIET="${PASSCONTROL_QUIET:-}"
say() { [[ "$QUIET" == "1" ]] || echo "$@"; }
OFFSET="${PASSCONTROL_PORT_OFFSET:-0}"
if ! [[ "$OFFSET" =~ ^[0-9]+$ ]] || (( OFFSET > 10000 )); then
  echo "✗ PASSCONTROL_PORT_OFFSET must be an integer from 0 to 10000." >&2; exit 1
fi
PROJECT_ID="$(basename "$SRC")"
[[ "$OFFSET" == "0" ]] || PROJECT_ID+="-$OFFSET"
API_PORT=$((54321 + OFFSET))
SRH_PORT=$((8079 + OFFSET))
COMPOSE_PROJECT_NAME="passcontrol_${PROJECT_ID//[^A-Za-z0-9]/_}"
COMPOSE_PROJECT_NAME="$(printf '%s' "$COMPOSE_PROJECT_NAME" | tr '[:upper:]' '[:lower:]')"
# The generated local stack uses a shared invite code. Do not pass the optional
# database-invite hook flag here: it would reject every signup from the local UI.
node "$SRC/scripts/write-local-supabase-config.mjs" "$SRC" "$PROJECT_ID" "$OFFSET" "${PORT:-3000}"

# ── 1. Prereqs ────────────────────────────────────────────────────────────────
command -v docker >/dev/null || { echo "✗ docker not found — install Docker Desktop." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "✗ Docker daemon not running — start Docker Desktop." >&2; exit 1; }
command -v supabase >/dev/null || { echo "✗ supabase CLI not found — install: brew install supabase/tap/supabase" >&2; exit 1; }
command -v node >/dev/null || { echo "✗ node not found." >&2; exit 1; }

# ── 2. Supabase local stack (Postgres + Vault + Auth + Kong) ──────────────────
# We exclude `studio` — PassControl ships its own dashboard, and Supabase's Studio
# image is flaky here (unhealthy → `supabase start` rolls the whole stack back).
# Studio is a leaf (nothing depends on it), so this is safe; other services are
# left as-is to avoid dependency-health surprises (e.g. analytics ← vector).
echo "→ Starting Supabase local stack (first run pulls images — be patient)…"
if [[ "$QUIET" == "1" ]]; then
  START_LOG="$(mktemp)"
  if ! supabase start -x studio >"$START_LOG" 2>&1; then
    cat "$START_LOG" >&2; rm -f "$START_LOG"; exit 1
  fi
  rm -f "$START_LOG"
  # Pull connection details (sets API_URL, ANON_KEY, SERVICE_ROLE_KEY, DB_URL, …)
  eval "$(supabase status -o env 2>/dev/null)"
else
  supabase start -x studio
  # Pull connection details (sets API_URL, ANON_KEY, SERVICE_ROLE_KEY, DB_URL, …)
  eval "$(supabase status -o env)"
fi

# ── 3. Redis + SRH (the Upstash-REST piece the CLI doesn't provide) ───────────
say "→ Starting redis + serverless-redis-http…"
if [[ "$QUIET" == "1" ]]; then
  COMPOSE_LOG="$(mktemp)"
  if ! COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" PASSCONTROL_SRH_PORT="$SRH_PORT" docker compose -f docker/compose.yml up -d >"$COMPOSE_LOG" 2>&1; then
    cat "$COMPOSE_LOG" >&2; rm -f "$COMPOSE_LOG"; exit 1
  fi
  rm -f "$COMPOSE_LOG"
else
  COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" PASSCONTROL_SRH_PORT="$SRH_PORT" docker compose -f docker/compose.yml up -d >/dev/null
fi

# ── 4. Generate .env.docker (preserve previously generated secrets) ───────────
# This file is rewritten from scratch every run, so anything not read back here
# is silently rotated. That is harmless for the symmetric secrets — a visa lives
# five minutes and a rotation heals itself — but NOT for INSTANCE_SIGNING_KEY:
# a receipt has no exp, and it is verified by fetching this instance's JWKS and
# matching `kid`. Regenerate the seed and the matching public key vanishes from
# that key set, so every receipt this stack ever signed stops verifying at once,
# with nothing anywhere reporting why. Carried forward deliberately.
gen() { openssl rand -base64 32 | tr -d '\n'; }
VISA_SECRET=""; CACHE_ENC_KEY=""; CRON_SECRET=""
INSTANCE_SIGNING_KEY=""; INSTANCE_SIGNING_KEY_PREV=""; INSTANCE_SIGNING_KEY_HISTORY=""
PASSCONTROL_SYSTEM_OPERATOR_EMAILS=""; PASSCONTROL_SIGNUP_MODE=""
if [[ -f "$ENVF" ]]; then
  VISA_SECRET=$(grep '^VISA_SECRET=' "$ENVF" | cut -d= -f2- || true)
  CACHE_ENC_KEY=$(grep '^CACHE_ENC_KEY=' "$ENVF" | cut -d= -f2- || true)
  CRON_SECRET=$(grep '^CRON_SECRET=' "$ENVF" | cut -d= -f2- || true)
  INSTANCE_SIGNING_KEY=$(grep '^INSTANCE_SIGNING_KEY=' "$ENVF" | cut -d= -f2- || true)
  INSTANCE_SIGNING_KEY_PREV=$(grep '^INSTANCE_SIGNING_KEY_PREV=' "$ENVF" | cut -d= -f2- || true)
  # Append-only and permanent: it is the ONLY record of keys retired more than
  # one rotation ago. Regenerating this file without it silently un-publishes
  # them, which is the same mass-invalidation described above one step removed.
  INSTANCE_SIGNING_KEY_HISTORY=$(grep '^INSTANCE_SIGNING_KEY_HISTORY=' "$ENVF" | cut -d= -f2- || true)
  # Who may open System Health. The seed fills it with the account it creates;
  # `passcontrol update` skips the seed, so it must be carried forward here.
  PASSCONTROL_SYSTEM_OPERATOR_EMAILS=$(grep '^PASSCONTROL_SYSTEM_OPERATOR_EMAILS=' "$ENVF" | cut -d= -f2- || true)
  # Sign-up is off by default (setup seeds your account); a mode you set stays.
  PASSCONTROL_SIGNUP_MODE=$(grep '^PASSCONTROL_SIGNUP_MODE=' "$ENVF" | cut -d= -f2- || true)
fi
VISA_SECRET=${VISA_SECRET:-$(gen)}
CACHE_ENC_KEY=${CACHE_ENC_KEY:-$(gen)}
CRON_SECRET=${CRON_SECRET:-$(gen)}
# 32 random bytes, the Ed25519 seed length. instanceKey.ts normalises standard
# base64 to base64url on read, so `gen` is the right generator here too.
INSTANCE_SIGNING_KEY=${INSTANCE_SIGNING_KEY:-$(gen)}
# Deliberately NOT generated: an empty _PREV is the correct state until an actual
# rotation puts the old seed here. decodeSeed() treats empty as "no key" and the
# JWKS simply omits the second entry.

cat > "$ENVF" <<EOF
# Generated by scripts/dev-stack.sh — LOCAL DEV ONLY. gitignored. Do not commit.
NEXT_PUBLIC_SUPABASE_URL=$API_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
UPSTASH_REDIS_REST_URL=http://localhost:$SRH_PORT
UPSTASH_REDIS_REST_TOKEN=passcontrol_local_dev_token
VISA_SECRET=$VISA_SECRET
VISA_TTL_SECONDS=300
CACHE_ENC_KEY=$CACHE_ENC_KEY
CRON_SECRET=$CRON_SECRET
INSTANCE_SIGNING_KEY=$INSTANCE_SIGNING_KEY
INSTANCE_SIGNING_KEY_PREV=$INSTANCE_SIGNING_KEY_PREV
INSTANCE_SIGNING_KEY_HISTORY=$INSTANCE_SIGNING_KEY_HISTORY
PASSCONTROL_ISSUER=http://localhost:${PORT:-3000}
INVITE_CODE=local-dev
# One developer per install, and setup seeds your account, so sign-up is off.
# Set to invite (uses INVITE_CODE) or open to add more local accounts.
PASSCONTROL_SIGNUP_MODE=${PASSCONTROL_SIGNUP_MODE:-closed}
PASSCONTROL_DEMO=${PASSCONTROL_DEMO:-0}
# Lets a provider credential go to your own server, e.g. Ollama at
# http://localhost:11434/v1 (Settings -> Endpoint). Set to off to refuse them.
PROVIDER_ENDPOINT_MODE=selfhost
# Who may open System Health (two-factor still required). The seed adds your account.
PASSCONTROL_SYSTEM_OPERATOR_EMAILS=$PASSCONTROL_SYSTEM_OPERATOR_EMAILS
EOF
# An offset install's dashboard port, so `npm run dev:docker` by hand serves it
# where the issuer above and Supabase's site URL say it is. Only for an offset:
# scripts/dev-docker.mjs lets the file win over the environment, and a default
# install must keep honouring a PORT someone sets on purpose.
[[ "$OFFSET" == "0" ]] || echo "PORT=${PORT:-3000}" >> "$ENVF"
say "→ Wrote .env.docker"

# ── 5. Migrations — run INSIDE the Supabase DB container (no host psql needed) ─
# Mirrors scripts/migrate.sh's ledger, but via docker exec. Each file + its
# ledger insert run in ONE transaction (psql -1) so a non-idempotent migration
# (e.g. 0005) can never be half-applied.
DBC=$(docker ps --filter "label=com.supabase.cli.project=$PROJECT_ID" --filter name=supabase_db --format '{{.Names}}' | head -1)
[[ -n "$DBC" ]] || { echo "✗ Could not find the Supabase DB container." >&2; exit 1; }
# Warnings and errors only: idempotent migrations print a NOTICE for every
# "already exists, skipping", which buried the lines that mattered.
PSQL=(docker exec -i -e PGOPTIONS=--client-min-messages=warning "$DBC" psql -U postgres -d postgres -v ON_ERROR_STOP=1)
say "→ Applying migrations (in $DBC)…"
REBASELINE="${PASSCONTROL_LEDGER_REBASELINE:-}"
checksum() { openssl dgst -sha256 "$1" | awk '{ print $NF }'; }

# Locked as it is created, not by 0019 alone: Supabase's default privileges on
# schema `public` grant every table postgres creates there to `anon` and
# `authenticated`, so the ledger is reachable through PostgREST from the instant
# it exists. One transaction, not four `-c` calls, so the table is never visible
# unlocked. Every statement is idempotent and `postgres` owns the table, so the
# loop below keeps working. See 0019_lock_migration_ledger.sql, and
# scripts/migrate.sh — this is the same ledger, reached the other way, and the
# two must not drift.
#
# `vetted` (does the ledger carry the owner-only `checksum` column?) and
# `recorded` are observed inside that transaction, before it locks anything.
state="$("${PSQL[@]}" -tA -q <<'SQL'
begin;
create table if not exists public.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);
-- Before counting. The revoke below takes this lock anyway, but not until after
-- the count, and a row that commits in between would be counted as absent — an
-- un-vetted ledger would then be marked vetted with that row inside it.
lock table public.schema_migrations in access exclusive mode;
create temporary table _pc_ledger_state on commit drop as
  select
    exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'schema_migrations'
        and column_name = 'checksum'
    ) as vetted,
    (select count(*) from public.schema_migrations) as recorded;
revoke all on public.schema_migrations from anon;
revoke all on public.schema_migrations from authenticated;
alter table public.schema_migrations enable row level security;
select vetted, recorded from _pc_ledger_state;
commit;
SQL
)"
state="$(tr -d '[:space:]' <<<"$state")"
[[ -n "$state" ]] || { echo "✗ Could not read the migration ledger's state." >&2; exit 1; }
vetted="${state%%|*}"
recorded="${state##*|}"

# A row in an un-vetted ledger may name a migration that never ran — the table
# was writable through PostgREST until the lockdown. Believing it makes this
# script SKIP that migration and still report success, which is how a security
# migration gets suppressed silently. Refuse once, out loud.
if [[ "$vetted" != "t" ]]; then
  if [[ "$recorded" != "0" && "$REBASELINE" != "keep" ]]; then
    versions="$("${PSQL[@]}" -At -c "select version from public.schema_migrations order by version;")"
    {
      echo "✗ Refusing to migrate: this stack's ledger has never been vetted."
      echo
      echo "  Recorded as applied ($recorded):"
      sed 's/^/    /' <<<"$versions"
      first_missing=""
      for f in db/migrations/*.sql; do
        v="$(basename "$f")"
        grep -qxF "$v" <<<"$versions" || { first_missing="$v"; break; }
      done
      if [[ -n "$first_missing" ]]; then
        ahead="$(awk -v cut="$first_missing" '$0 > cut' <<<"$versions")"
        if [[ -n "$ahead" ]]; then
          echo
          echo "  Recorded even though $first_missing is NOT — this is what a forged"
          echo "  row looks like:"
          sed 's/^/    /' <<<"$ahead"
        fi
      fi
      echo
      echo "  Check the schema against that list, delete any row that is wrong, and"
      echo "  then re-run:"
      echo
      echo "      PASSCONTROL_LEDGER_REBASELINE=keep npm run dev:stack"
      echo
      echo "  Or, for a local stack, throw it away and start clean:"
      echo "      supabase stop --no-backup && npm run dev:stack"
    } >&2
    exit 1
  fi
  "${PSQL[@]}" -q -c "alter table public.schema_migrations add column if not exists checksum text;"
  [[ "$recorded" == "0" ]] || echo "  → rebaseline: accepting the $recorded version(s) already recorded."
fi

applied="$("${PSQL[@]}" -At -c "select version || '|' || coalesce(checksum, '') from public.schema_migrations;")"
already=0
for f in db/migrations/*.sql; do
  v="$(basename "$f")"
  sum="$(checksum "$f")"
  # Exact match on the version field, not a substring of some other row.
  row="$(awk -F'|' -v v="$v" '$1 == v { print; exit }' <<<"$applied")"
  if [[ -n "$row" ]]; then
    have="${row#*|}"
    if [[ -z "$have" || ( "$have" != "$sum" && "$REBASELINE" == "keep" ) ]]; then
      "${PSQL[@]}" -q -c "update public.schema_migrations set checksum = '$sum' where version = '$v';"
      say "  = $v (already applied, checksum recorded)"
    elif [[ "$have" != "$sum" ]]; then
      echo "✗ $v has changed since it was applied to this stack (recorded $have, on disk $sum)." >&2
      echo "  Applied migrations are immutable. Restore the file, or re-stamp with" >&2
      echo "  PASSCONTROL_LEDGER_REBASELINE=keep if the schema already reflects it." >&2
      exit 1
    else
      say "  = $v (already applied)"
    fi
    already=$((already + 1))
    continue
  fi
  echo "  + $v"
  { cat "$f"; printf "\ninsert into public.schema_migrations (version, checksum) values ('%s', '%s');\n" "$v" "$sum"; } | "${PSQL[@]}" -1 -q
done
if [[ "$QUIET" == "1" ]]; then echo "  $already already applied"; fi

# ── 6. Seed a confirmed dev user ──────────────────────────────────────────────
# `passcontrol update` re-runs this script for its migrations on an install that
# already has its account, and sets PASSCONTROL_SKIP_SEED=1 so an update never
# opens an account-setup conversation. Everything above still runs.
if [[ "${PASSCONTROL_SKIP_SEED:-}" == "1" ]]; then
  say "→ Skipping the dev-user seed (PASSCONTROL_SKIP_SEED=1)."
else
  echo "→ Seeding dev user…"
  set -a; . "$ENVF"; set +a
  # Relative on purpose: we are in "$SRC" (cd above), and Git Bash on Windows
  # converts POSIX paths in arguments but not in environment values.
  PASSCONTROL_ENV_FILE=.env.docker node scripts/seed.mjs
fi

# ── 7. Done ───────────────────────────────────────────────────────────────────
# `passcontrol setup` sets PASSCONTROL_VIA_CLI=1 and starts the dashboard itself
# right after this, so its user gets CLI commands; a hand run gets npm ones.
# Read from the env file: it is a variable here only when step 6 sourced it,
# which PASSCONTROL_SKIP_SEED skips.
INVITE_CODE="$(grep '^INVITE_CODE=' "$ENVF" | cut -d= -f2- || true)"
SIGNUP_MODE="$(grep '^PASSCONTROL_SIGNUP_MODE=' "$ENVF" | cut -d= -f2- || true)"
if [[ "$SIGNUP_MODE" == "closed" ]]; then
  SIGNUP_LINE="off (set PASSCONTROL_SIGNUP_MODE in .env.docker to add local accounts)"
else
  SIGNUP_LINE="${SIGNUP_MODE:-invite} · invite code ${INVITE_CODE}"
fi
if [[ "$QUIET" == "1" ]]; then
  : # The CLI prints its own conclusion.
elif [[ "${PASSCONTROL_VIA_CLI:-}" == "1" ]]; then
cat <<DONE

✅ Local stack is up.
   Supabase API    : ${API_URL}   (Studio UI is excluded — use the PassControl dashboard)
   Sign-up         : ${SIGNUP_LINE}
   Stop everything : passcontrol stop   (data is kept)
DONE
else
cat <<DONE

✅ Local stack is up.
   Supabase API    : ${API_URL}   (Studio UI is excluded — use the PassControl dashboard)
   Start the app   : npm run dev:docker
                     → http://localhost:${PORT:-3000}  (log in with the account you just created)
   Sign-up         : ${SIGNUP_LINE}

   Then: add a provider key + issue a passport in the dashboard, and run:
         node examples/chat-agent.mjs "Say hi in 3 words"

   Stop everything : supabase stop && docker compose -f docker/compose.yml down
                     (data is kept; add -v to the compose command to also wipe Redis)
DONE
fi
