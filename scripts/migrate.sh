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
# "keep" = the operator has inspected the recorded list and vouches for it. See
# the refusal message below; there is deliberately no way to say this in a file.
REBASELINE="${PASSCONTROL_LEDGER_REBASELINE:-}"

[ -z "$DB" ] && { echo "✗ Set DATABASE_URL (your Supabase Postgres connection string)." >&2; exit 1; }
command -v psql >/dev/null 2>&1 || { echo "✗ psql not found — install the PostgreSQL client." >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "✗ openssl not found — needed to checksum migrations." >&2; exit 1; }

checksum() { openssl dgst -sha256 "$1" | awk '{ print $NF }'; }

# ── The ledger, created and locked in ONE transaction ─────────────────────────
#
# The lockdown is part of creating it, not a migration alone. Supabase's default
# privileges on schema `public` grant every table postgres creates there to
# `anon` and `authenticated`, so the ledger is world-readable AND world-writable
# through PostgREST from the instant it exists — before 0019 gets a chance to
# close it. Four separate `psql -c` calls are four transactions and leave that
# window open for three round trips, so all of it commits together or not at
# all. Every statement is idempotent and `postgres` owns the table, so the loop
# below is unaffected. See 0019_lock_migration_ledger.sql.
#
# The same transaction reports the two facts the rest of this script needs,
# observed BEFORE it locks anything, so nothing can change in between:
#
#   vetted   — does the ledger already carry the `checksum` column? Adding a
#              column needs table ownership, which is exactly what `anon` and
#              `authenticated` lack. Its presence is therefore proof that a run
#              of THIS script already vouched for the rows; it cannot be forged
#              through PostgREST the way a row can.
#   recorded — how many migrations the ledger claims are already applied.
state="$(psql -tA -q -v ON_ERROR_STOP=1 "$DB" <<'SQL'
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
[ -n "$state" ] || { echo "✗ Could not read the migration ledger's state." >&2; exit 1; }
vetted="${state%%|*}"
recorded="${state##*|}"

# ── Does this ledger deserve to be believed? ──────────────────────────────────
#
# Locking the table does not make the rows that were already in it true. A row
# naming a migration that never ran makes this script SKIP that migration and
# still print success — the worst failure mode a migration tool has, and a
# silent way to suppress a security migration. So an un-vetted, non-empty ledger
# is refused once, out loud, rather than trusted by default.
if [ "$vetted" != "t" ]; then
  if [ "$recorded" != "0" ] && [ "$REBASELINE" != "keep" ]; then
    versions="$(psql -At -v ON_ERROR_STOP=1 "$DB" -c "select version from public.schema_migrations order by version;")"
    {
      echo "✗ Refusing to migrate: this ledger has never been vetted."
      echo
      echo "  public.schema_migrations was reachable through PostgREST (anon and"
      echo "  authenticated) on every database migrated before the lockdown, so any"
      echo "  row in it may have been written by someone who never ran the migration"
      echo "  it names. This run has locked the table — but locking cannot make the"
      echo "  rows that were already there trustworthy, and a forged row would make"
      echo "  this script skip a migration and report success."
      echo
      echo "  Recorded as applied ($recorded):"
      sed 's/^/    /' <<<"$versions"

      # Diagnostics, not the decision. A forged row is usually AHEAD of the real
      # high-water mark, which shows up as a version recorded after a gap.
      first_missing=""
      for f in "$SRC"/db/migrations/*.sql; do
        v="$(basename "$f")"
        grep -qxF "$v" <<<"$versions" || { first_missing="$v"; break; }
      done
      if [ -n "$first_missing" ]; then
        ahead="$(awk -v cut="$first_missing" '$0 > cut' <<<"$versions")"
        if [ -n "$ahead" ]; then
          echo
          echo "  Recorded even though $first_missing is NOT — this is what a forged"
          echo "  row looks like:"
          sed 's/^/    /' <<<"$ahead"
        fi
      fi
      # `true` closes the loop's status: under `set -e` a final iteration that
      # found no orphan would otherwise abort this message half-written.
      orphans="$(
        while read -r v; do
          [ -n "$v" ] || continue
          [ -f "$SRC/db/migrations/$v" ] || echo "$v"
        done <<<"$versions"
        true
      )"
      if [ -n "$orphans" ]; then
        echo
        echo "  Recorded but not a migration file in this checkout:"
        sed 's/^/    /' <<<"$orphans"
      fi

      echo
      echo "  Check the schema against that list. Delete any row that is wrong (as"
      echo "  the table owner — PostgREST can no longer reach it), then, once you"
      echo "  are satisfied the list is correct, re-run:"
      echo
      echo "      PASSCONTROL_LEDGER_REBASELINE=keep npm run migrate"
      echo
      echo "  That accepts the recorded list AS IT STANDS and stamps a checksum for"
      echo "  each row, so you are asked this exactly once."
    } >&2
    exit 1
  fi

  # Either the ledger is empty (nothing to forge) or the operator has vouched
  # for it. Mark it vetted — this is what stops the question being asked again,
  # and it is written now that the table is locked.
  psql -v ON_ERROR_STOP=1 -q "$DB" \
    -c "alter table public.schema_migrations add column if not exists checksum text;" >/dev/null
  [ "$recorded" = "0" ] || echo "→ rebaseline: accepting the $recorded version(s) already recorded."
fi

# version|checksum for everything the ledger claims. The checksum is empty for
# rows written before this script recorded them.
applied="$(psql -At -v ON_ERROR_STOP=1 "$DB" -c "select version || '|' || coalesce(checksum, '') from public.schema_migrations;")"

shopt -s nullglob
ran=0
for f in "$SRC"/db/migrations/*.sql; do
  v="$(basename "$f")"
  sum="$(checksum "$f")"
  # Exact match on the version field — a substring match could let one migration
  # be answered by another's row.
  row="$(awk -F'|' -v v="$v" '$1 == v { print; exit }' <<<"$applied")"

  if [ -n "$row" ]; then
    have="${row#*|}"
    if [ -z "$have" ] || { [ "$have" != "$sum" ] && [ "$REBASELINE" = "keep" ]; }; then
      # Trust on first use for a row this script did not stamp, and a re-stamp
      # for an operator who has just vouched for the list.
      psql -v ON_ERROR_STOP=1 -q "$DB" \
        -c "update public.schema_migrations set checksum = '$sum' where version = '$v';" >/dev/null
      echo "• skip   $v (checksum recorded)"
    elif [ "$have" != "$sum" ]; then
      {
        echo "✗ $v has changed since it was applied to this database."
        echo "  recorded sha256 $have"
        echo "  on disk  sha256 $sum"
        echo
        echo "  The database and this checkout disagree about what ran. Applied"
        echo "  migrations are immutable; put the file back, or — if the change is"
        echo "  known-good and already reflected in the schema — re-stamp with"
        echo "  PASSCONTROL_LEDGER_REBASELINE=keep."
      } >&2
      exit 1
    else
      echo "• skip   $v"
    fi
    continue
  fi

  echo "→ apply  $v"
  # Run the file and record it in ONE transaction (-1): a failure rolls back and
  # is NOT recorded, so the next run retries it cleanly. psql executes -f then -c
  # in command-line order.
  psql -1 -v ON_ERROR_STOP=1 -q "$DB" \
    -f "$f" \
    -c "insert into public.schema_migrations (version, checksum) values ('$v', '$sum');"
  ran=$((ran + 1))
done

echo "✓ migrate done — $ran new migration(s) applied."
