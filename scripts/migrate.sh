#!/usr/bin/env bash
# Apply db/migrations/*.sql to a Postgres (Supabase) database, in order, exactly
# once each. Uses a ledger table (public.schema_migrations) so re-running is safe —
# important because some migrations are NOT idempotent (e.g. 0005 renames a column
# and scales spend values; applying it twice would corrupt data).
#
# Needs the `psql` client and a connection string:
#   DATABASE_URL='postgresql://postgres:<pwd>@db.<ref>.supabase.co:5432/postgres' npm run migrate
# (Supabase dashboard → Project Settings → Database → Connection string.)
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${DATABASE_URL:-}"

[ -z "$DB" ] && { echo "✗ Set DATABASE_URL (your Supabase Postgres connection string)." >&2; exit 1; }
command -v psql >/dev/null 2>&1 || { echo "✗ psql not found — install the PostgreSQL client." >&2; exit 1; }

# Ledger of applied migrations (created once; harmless if it already exists).
psql -v ON_ERROR_STOP=1 -q "$DB" -c \
  "create table if not exists public.schema_migrations (version text primary key, applied_at timestamptz not null default now());" >/dev/null

applied="$(psql -At -v ON_ERROR_STOP=1 "$DB" -c "select version from public.schema_migrations;")"

shopt -s nullglob
ran=0
for f in "$SRC"/db/migrations/*.sql; do
  v="$(basename "$f")"
  if grep -qxF "$v" <<<"$applied"; then
    echo "• skip   $v"
    continue
  fi
  echo "→ apply  $v"
  # Run the file and record it in ONE transaction (-1): a failure rolls back and
  # is NOT recorded, so the next run retries it cleanly. psql executes -f then -c
  # in command-line order.
  psql -1 -v ON_ERROR_STOP=1 -q "$DB" \
    -f "$f" \
    -c "insert into public.schema_migrations (version) values ('$v');"
  ran=$((ran + 1))
done

echo "✓ migrate done — $ran new migration(s) applied."
