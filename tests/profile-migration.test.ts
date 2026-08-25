// The database side of the public operator profile.
//
// lib/profile/public.ts pins the rendered shape; this pins the two things that
// live outside it — what the SQL functions are allowed to return, and to whom.
// Modelled on tests/public-verification-migration.test.ts, including its habit of
// resolving the migration that CURRENTLY defines each function rather than
// hardcoding the one that introduced it: when 0017 redefined verify_passport, a
// hardcoded 0015 guard would have kept passing green against a file that no
// longer described the live database.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(process.cwd(), "db/migrations");

function liveDefinitionOf(functionName: string): string {
  const createRe = new RegExp(`create (or replace )?function public\\.${functionName}\\s*\\(`, "i");
  const file = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .reverse()
    .find((name) => createRe.test(readFileSync(join(MIGRATIONS_DIR, name), "utf8")));
  expect(file, `no migration defines public.${functionName}`).toBeTruthy();
  return readFileSync(join(MIGRATIONS_DIR, file!), "utf8");
}

/** SQL with `--` comments removed, so an assertion cannot be satisfied — or
 *  defeated — by prose. The migration headers here discuss the very statements
 *  being asserted on, so this is not optional. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** The `returns table (...)` clause for one function, as a list of column names.
 *  Terminates on the `language` that follows the clause rather than on a newline
 *  before `)`, because a single-column function writes it all on one line. */
function returnedColumns(sql: string, functionName: string): string[] {
  const fromFunction = sql.slice(sql.search(new RegExp(`function public\\.${functionName}\\s*\\(`, "i")));
  const clause = fromFunction.match(/returns table \(([\s\S]*?)\)\s*\nlanguage/i)?.[1] ?? "";
  return clause
    .split(/[\n,]/)
    .map((line) => line.trim().split(/\s+/)[0] ?? "")
    .filter(Boolean);
}

/** The `as $$ … $$` body of one function, comments removed.
 *
 *  Stripping matters more than it looks: these bodies carry comments that name
 *  the very thing being forbidden ("never be tempted to coalesce to a.name"), so
 *  a raw match finds the warning and reports it as the violation. */
function body(sql: string, functionName: string): string {
  const fromFunction = sql.slice(sql.search(new RegExp(`function public\\.${functionName}\\s*\\(`, "i")));
  return stripComments(fromFunction.match(/as \$\$([\s\S]*?)\$\$/)?.[1] ?? "");
}

const PROFILE = "public_operator_profile";
const AGENTS = "public_operator_agents";
const AVATAR = "avatar_object_path";

describe("public_operator_profile", () => {
  const sql = liveDefinitionOf(PROFILE);

  it("returns only the columns the public page is allowed to render", () => {
    expect(returnedColumns(sql, PROFILE).sort()).toEqual([
      "avatar_key",
      "bio",
      "company",
      "display_name",
      "is_verified",
      "member_since",
      "owner_subject",
      "owner_tier",
      "owner_verified_at",
      "published_agent_count",
      "username",
      "website_url",
    ]);
  });

  // The returns clause is the surface; the body may legitimately touch a private
  // column in a join predicate, which is why this asserts on the clause. Same
  // distinction tests/public-verification-migration.test.ts had to make once the
  // owner join arrived.
  it("never returns a private column", () => {
    const returns = returnedColumns(sql, PROFILE).join(" ");
    for (const column of [
      "user_id",
      "email",
      "plan",
      "timezone",
      "avatar_path",
      "verification_token",
      "owner_kind",
      "budget",
      "spent",
      "allowed_scopes",
      "policy",
      "fallbacks",
    ]) {
      expect(returns, `${column} must not be public`).not.toContain(column);
    }
  });

  // 0017 is emphatic that a "verified" label keys off `tier` (what was proven),
  // never `kind` (what was merely attempted). A column that cannot be read
  // cannot be misread, so kind is deliberately absent rather than merely unused.
  it("does not expose agent_owners.kind at all", () => {
    expect(returnedColumns(sql, PROFILE)).not.toContain("owner_kind");
    expect(body(sql, PROFILE)).not.toMatch(/o\.kind/i);
  });

  it("shows an owner only once it has been published, without hiding the profile", () => {
    const src = body(sql, PROFILE);
    expect(src).toMatch(/left join public\.agent_owners/i);
    // In the WHERE this would suppress the whole profile for an operator who
    // never published an owner binding.
    expect(src).toMatch(/on o\.user_id = u\.id and o\.published/i);
  });

  it("derives the social check from the server-only verification registry", () => {
    const src = body(sql, PROFILE);
    expect(src).toMatch(/left join public\.profile_verifications/i);
    expect(src).toMatch(/v\.user_id = u\.id/i);
    expect(src).toMatch(/\(v\.user_id is not null\)/i);
  });

  it("drops the old OUT-row signature before adding the verification column", () => {
    const lower = sql.toLowerCase();
    const drop = lower.indexOf("drop function if exists public.public_operator_profile(text)");
    const create = lower.indexOf("create or replace function public.public_operator_profile");
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
  });

  // A key with no stored object resolves to 404 at avatar_object_path, and the
  // public page cannot detect that: avatar_path is deliberately private, so it
  // has nothing else to test. Publishing such a key rendered a broken image on
  // a stranger's screen.
  it("publishes the avatar key only when there are bytes behind it", () => {
    expect(body(sql, PROFILE)).toMatch(
      /case when u\.avatar_path is not null then u\.avatar_key end/i
    );
  });

  it("requires the profile opt-in", () => {
    expect(body(sql, PROFILE)).toMatch(/and u\.profile_public/i);
  });

  // The tempting addition, refused on purpose. 0015's deny-list names agent_logs
  // because call volume is operational; a public receipt count would be a
  // doctrine amendment and 0017 set the precedent that those get argued in a
  // migration header, not slipped in as a count(*).
  it("counts published agents and never touches agent_logs", () => {
    const src = body(sql, PROFILE);
    expect(src).not.toMatch(/agent_logs/i);
    expect(src).toMatch(/from public\.agents a[\s\S]*?where a\.user_id = u\.id and a\.published/i);
  });
});

describe("public_operator_agents", () => {
  const sql = liveDefinitionOf(AGENTS);

  it("returns only the columns the public list is allowed to render", () => {
    expect(returnedColumns(sql, AGENTS).sort()).toEqual([
      "created_at",
      "label",
      "passport_pubkey",
      "status",
    ]);
  });

  // 0015 refuses `name` on the public passport surface because internal agent
  // names are customer-identifying: `acme-prod-billing` published under a
  // vendor's handle is a customer list. public_label is the separate opt-in.
  it("publishes public_label, never the internal agent name", () => {
    const src = body(sql, AGENTS);
    expect(src).toMatch(/a\.public_label/);
    expect(src).not.toMatch(/\ba\.name\b/);
    expect(returnedColumns(sql, AGENTS)).not.toContain("name");
  });

  it("requires BOTH opt-ins", () => {
    const src = body(sql, AGENTS);
    expect(src).toMatch(/and u\.profile_public/i);
    expect(src).toMatch(/and a\.published/i);
  });

  // The value of the list is that every row is independently checkable at
  // /verify/<pubkey>. 0023 made passport_pubkey nullable for Direct Agent Key
  // agents, and a row nobody can verify does not belong on a verification page.
  it("lists only agents that can actually be verified", () => {
    expect(body(sql, AGENTS)).toMatch(/and a\.passport_pubkey is not null/i);
  });

  it("is bounded, so a handle cannot become an unbounded query", () => {
    expect(body(sql, AGENTS)).toMatch(/limit least\(/i);
  });

  it("never returns a private column", () => {
    const returns = returnedColumns(sql, AGENTS).join(" ");
    for (const column of ["user_id", "budget", "spent", "allowed_scopes", "policy", "fallbacks"]) {
      expect(returns).not.toContain(column);
    }
    expect(body(sql, AGENTS)).not.toMatch(/agent_logs/i);
  });
});

describe("avatar_object_path", () => {
  const sql = liveDefinitionOf(AVATAR);

  // This function exists so the unauthenticated avatar route physically cannot
  // read the account row, even if a later edit is careless.
  it("returns exactly one column, the storage key", () => {
    expect(returnedColumns(sql, AVATAR)).toEqual(["object_path"]);
  });

  it("is keyed on the capability token, never on the tenant id or the handle", () => {
    const src = body(sql, AVATAR);
    expect(src).toMatch(/where u\.avatar_key = p_key/i);
    expect(src).not.toMatch(/u\.id\s*=/);
    expect(src).not.toMatch(/username/i);
  });
});

describe("every public profile function", () => {
  for (const [fn, signature] of [
    [PROFILE, "text"],
    [AGENTS, "text, integer"],
    [AVATAR, "text"],
  ] as const) {
    const sql = liveDefinitionOf(fn);

    it(`${fn} runs as definer with a pinned search_path`, () => {
      const fromFunction = sql.slice(sql.search(new RegExp(`function public\\.${fn}\\s*\\(`, "i")));
      const head = fromFunction.slice(0, fromFunction.indexOf("as $$"));
      expect(head).toMatch(/security definer/i);
      // An unpinned search_path on a definer function is how a definer function
      // becomes a privilege-escalation primitive.
      expect(head).toMatch(/set search_path = ''/i);
      expect(head).toMatch(/\bstable\b/i);
    });

    // 0015's central protection, and the one 0017's header records as easy to
    // lose: a newly created function defaults to EXECUTE for PUBLIC.
    it(`${fn} is service_role-only, so anon gains no new database surface`, () => {
      const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(sql).toMatch(
        new RegExp(`revoke all on function public\\.${fn}\\(${escaped}\\) from public, anon, authenticated;`, "i")
      );
      expect(sql).toMatch(
        new RegExp(`grant execute on function public\\.${fn}\\(${escaped}\\) to service_role;`, "i")
      );
    });
  }
});

describe("the handle lock (0034)", () => {
  const MIGRATIONS_DIR2 = join(process.cwd(), "db/migrations");
  const sql = readFileSync(join(MIGRATIONS_DIR2, "0034_lock_published_handle.sql"), "utf8");

  it("stamps the lock in a column that can only be set, never cleared by schema", () => {
    expect(sql).toMatch(/add column if not exists handle_locked_at\s+timestamptz/i);
  });

  // The backstop, in the same shape as reject_retired_username: the rule is
  // enforced in lib/profile/manage.ts, and here too so a caller that forgets
  // cannot quietly move a handle other people have linked to.
  it("enforces the lock in the database as well as the application", () => {
    const code = stripComments(sql);
    expect(code).toMatch(/create or replace function public\.reject_locked_username/i);
    expect(code).toMatch(/old\.handle_locked_at is not null/i);
    expect(code).toMatch(/new\.username is distinct from old\.username/i);
    expect(code).toMatch(/before update of username on public\.users/i);
  });

  it("runs as definer with a pinned search_path, like every other trigger here", () => {
    const head = sql.slice(
      sql.search(/function public\.reject_locked_username/i),
      sql.indexOf("as $$", sql.search(/function public\.reject_locked_username/i))
    );
    expect(head).toMatch(/security definer/i);
    expect(head).toMatch(/set search_path = ''/i);
  });

  // The property change_handle exists for. Both writes must sit inside ONE
  // subtransaction, or a refused rename leaves the old handle retired and the
  // operator can never return to the name they still hold.
  it("retires and renames inside a single subtransaction", () => {
    const code = stripComments(sql);
    const fn = code.slice(code.search(/create or replace function public\.change_handle/i));
    const block = fn.slice(fn.indexOf("begin", fn.indexOf("exception when unique_violation") - 900));
    // The insert must come after the inner `begin` and before the handler.
    const innerBegin = fn.lastIndexOf("begin", fn.indexOf("insert into public.retired_usernames"));
    const handler = fn.indexOf("exception when unique_violation");
    expect(innerBegin).toBeGreaterThan(-1);
    expect(fn.indexOf("insert into public.retired_usernames")).toBeGreaterThan(innerBegin);
    expect(fn.indexOf("insert into public.retired_usernames")).toBeLessThan(handler);
    expect(fn.indexOf("update public.users")).toBeLessThan(handler);
    expect(block).toBeTruthy();
  });

  // An OUT parameter shadows a same-named column inside the body, and
  // `on conflict (username)` then fails to resolve — at RUNTIME, on the first
  // real call, from a function that created without complaint.
  it("does not name an OUT column after a column it writes", () => {
    const fn = stripComments(sql).slice(
      stripComments(sql).search(/create or replace function public\.change_handle/i)
    );
    const returns = fn.match(/returns table \(([^)]*)\)/i)?.[1] ?? "";
    expect(returns).not.toMatch(/\busername\b/);
    expect(returns).not.toMatch(/\bhandle_locked_at\b/);
  });

  it("is service_role-only, like every other function in this feature", () => {
    expect(sql).toMatch(/revoke all on function public\.change_handle\(uuid, text\) from public, anon, authenticated;/i);
    expect(sql).toMatch(/grant execute on function public\.change_handle\(uuid, text\) to service_role;/i);
  });

  // Only the handle freezes. An operator whose handle is permanent still edits
  // everything else about themselves.
  it("guards the username column only", () => {
    expect(stripComments(sql)).not.toMatch(/before update on public\.users/i);
  });
});

describe("the profile columns", () => {
  // These constraints live on tables, not in the function's latest
  // definition. 0040 legitimately redefines public_operator_profile without
  // repeating 0033's column DDL, so resolve the migration that introduced the
  // schema explicitly rather than coupling this block to the RPC helper above.
  const sql = readFileSync(join(MIGRATIONS_DIR, "0033_operator_profile.sql"), "utf8");

  it("keep the two opt-ins separate", () => {
    expect(sql).toMatch(/add column if not exists profile_public\s+boolean not null default false/i);
    expect(sql).toMatch(/add column if not exists published\s+boolean not null default false/i);
  });

  // A hostile href is the one genuinely new injection surface this feature adds.
  // Rejected in lib/profile/url.ts before the write; unstorable here as backstop.
  it("make a javascript: website_url unstorable", () => {
    expect(sql).toMatch(/users_website_url_scheme\s+check \(website_url is null or website_url ~ '\^https\?:\/\/'\)/i);
  });

  it("make an uppercase handle unstorable, so the unique index is case-insensitive", () => {
    expect(sql).toMatch(/users_username_shape[\s\S]{0,120}\^\[a-z0-9\]/i);
  });

  // 0011 granted four columns and 0018 appended `fallbacks`. A table-level revoke
  // and re-grant here would silently drop any column missing from the new list,
  // so this migration must not issue one at all.
  it("never re-issues a table-level revoke on public.agents", () => {
    // Comments stripped: this migration's header explicitly DISCUSSES not doing
    // this, so a raw match would find the prose and pass for the wrong reason.
    const statements = stripComments(sql);
    expect(statements).not.toMatch(/revoke update on public\.agents/i);
    expect(statements).not.toMatch(/grant update \([^)]*\) on public\.agents/i);
  });
});
