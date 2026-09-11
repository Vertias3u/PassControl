import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

/**
 * The check that would have caught CP-01, and the only one here that talks to a
 * real query planner.
 *
 * `tests/proxy-endpoint.test.ts` pins the SHAPE of the endpoint read against a
 * recording mock. That is the CI gate, and it is a good one — but a mock answers
 * whatever it is told to, whatever was asked, so it can only ever prove that the
 * code asks what we decided it should ask. It cannot prove PostgREST can plan it.
 * For nine days it did not: `provider_credentials` and `agents` have no foreign
 * key between them, both reference `users`, and the sibling-table embed the
 * resolver used answered PGRST200 / HTTP 400 every single time.
 *
 * So this file asks the real thing, over the same container the reproduction
 * used. It needs the local Supabase stack and is skipped — loudly, by name —
 * when that is not running, because a test nobody can run is how this recurs.
 */

const REST = "http://supabase_rest_PassControl:3000";
const DB_CONTAINER = "supabase_db_PassControl";
/** No such tenant. Planning is what is under test, not what comes back. */
const ABSENT_TENANT = "11111111-1111-4111-8111-111111111111";

function stackIsUp(): boolean {
  try {
    const names = execFileSync("docker", ["ps", "--format", "{{.Names}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return names.split("\n").includes(DB_CONTAINER);
  } catch {
    return false;
  }
}

/** Returns `{ status, body }` for a PostgREST query string, via the stack's own network. */
function ask(query: string): { status: number; body: string } {
  const out = execFileSync(
    "docker",
    ["exec", DB_CONTAINER, "curl", "-sS", "-g", "-w", "\n%{http_code}", `${REST}/${query}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  );
  const cut = out.lastIndexOf("\n");
  return { status: Number(out.slice(cut + 1).trim()), body: out.slice(0, cut) };
}

const up = stackIsUp();
const when = up ? it : it.skip;

/** psql against the same stack, for the grants PostgREST itself cannot show. */
function sql(query: string): string {
  return execFileSync(
    "docker",
    ["exec", DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-tAc", query],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  ).trim();
}

describe("the credential-bound decrypt path (0069)", () => {
  when(
    up
      ? "is executable by service_role and by nobody else"
      : "SKIPPED — local stack is not running, so the 0069 grants were never checked",
    () => {
      // has_function_privilege rather than `set role` + call: on this local PG a
      // denied function call under an assumed role takes the backend down. The
      // catalogue answers the same question without the crash.
      const fn = "public.get_provider_key_for_credential(uuid, text, uuid)";
      expect(sql(`select has_function_privilege('service_role','${fn}','EXECUTE');`)).toBe("t");
      expect(sql(`select has_function_privilege('authenticated','${fn}','EXECUTE');`)).toBe("f");
      expect(sql(`select has_function_privilege('anon','${fn}','EXECUTE');`)).toBe("f");
      // The unbound original keeps its own grants; this did not widen anything.
      const old = "public.get_provider_key(uuid, text)";
      expect(sql(`select has_function_privilege('authenticated','${old}','EXECUTE');`)).toBe("f");
    }
  );

  when(
    up
      ? "returns nothing for a credential id the agent does not own"
      : "SKIPPED — local stack is not running, so cross-tenant selection was never checked",
    () => {
      // The id is a selector inside an ownership join, never an authorization
      // token: an unrelated uuid selects no row rather than reaching one.
      const out = sql(
        `select coalesce(public.get_provider_key_for_credential(
           '11111111-1111-4111-8111-111111111111',
           'openai',
           '22222222-2222-4222-8222-222222222222'), 'NOTHING');`
      );
      expect(out).toBe("NOTHING");
    }
  );
});

describe("the endpoint read against real PostgREST", () => {
  when(
    up
      ? "plans the shape the resolver actually sends"
      : "SKIPPED — local Supabase stack is not running (`supabase start`), so the real planner was never asked",
    () => {
      const { status, body } = ask(
        `provider_credentials?select=id,endpoint_base_url&user_id=eq.${ABSENT_TENANT}` +
          `&provider=eq.openai&order=is_active.desc,created_at.asc&limit=1`
      );

      // 200 with an empty array: a real answer meaning "this tenant has no
      // active openai credential", which is exactly what the resolver treats as
      // "no endpoint" and caches. A 400 here is CP-01 returning.
      expect(body).not.toContain("PGRST200");
      expect(status).toBe(200);
    }
  );

  when(
    up
      ? "still cannot plan the sibling embed, which is why the shape above is pinned"
      : "SKIPPED — local Supabase stack is not running, so the failing shape was never re-checked",
    () => {
      const { status, body } = ask(
        `provider_credentials?select=endpoint_base_url,agents!inner(id)` +
          `&agents.id=eq.${ABSENT_TENANT}&provider=eq.openai&is_active=eq.true`
      );

      // Documents the constraint rather than assuming the reader knows it. If
      // someone ever adds a direct FK between these tables this test fails, and
      // that failure is the notification that the constraint changed — not a
      // reason to reinstate the embed.
      expect(status).toBe(400);
      expect(body).toContain("PGRST200");
    }
  );
});
