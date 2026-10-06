// Dashboard actions RETURN their failures instead of throwing them.
//
// In a production build Next replaces the message of anything a server action
// throws with "An error occurred in the Server Components render…" (seen
// 2026-10-04 on `next build` + `next start`: an account-limit sentence reached
// the browser as that). A returned value crosses intact. So the exported
// actions in app/dashboard/actions.ts return `{ ok, value | error }`, and the
// client module re-throws on the CLIENT, where the message survives, so every
// component's existing catch keeps working unchanged.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ActionError, GENERIC_ACTION_ERROR, unwrap } from "@/lib/action-result";
import { runAction } from "@/lib/run-action";

describe("runAction (server side)", () => {
  it("passes a value through", async () => {
    await expect(runAction("x", async () => 42)).resolves.toEqual({ ok: true, value: 42 });
  });

  it("returns an ActionError's message: written for people, safe to show", async () => {
    await expect(
      runAction("x", async () => {
        throw new ActionError("This workspace has reached its limit of 10 agents.");
      })
    ).resolves.toEqual({ ok: false, error: "This workspace has reached its limit of 10 agents." });
  });

  it("hides any other error's text, and logs it with the action's name", async () => {
    // A database or upstream error can echo what was submitted (a provider
    // key, say). Only ActionError text is ever shown.
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runAction("addProviderKey", async () => {
      throw new Error("duplicate key value: sk-proj-secret");
    });
    expect(result).toEqual({ ok: false, error: GENERIC_ACTION_ERROR });
    expect(log).toHaveBeenCalledWith("[dashboard:addProviderKey]", "Error");
    expect(JSON.stringify(log.mock.calls)).not.toContain("sk-proj-secret");
    log.mockRestore();
  });

  it("lets Next's own control flow through (redirect, notFound carry a digest)", async () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" });
    await expect(
      runAction("x", async () => {
        throw redirect;
      })
    ).rejects.toBe(redirect);
  });
});

describe("unwrap (client side)", () => {
  it("returns the value, or throws an Error carrying the returned message", () => {
    expect(unwrap({ ok: true, value: "token" })).toBe("token");
    expect(() => unwrap({ ok: false, error: "Key not found or already revoked." })).toThrow(
      "Key not found or already revoked."
    );
  });

  it("refuses anything that is not a result, so a wrapper mismatch is loud", () => {
    expect(() => unwrap(undefined as never)).toThrow(GENERIC_ACTION_ERROR);
  });
});

describe("components go through the client module", () => {
  // A component that called the server action directly would get the result
  // object back and IGNORE it: `await revokeApiKey(id)` would read as success
  // when the revoke failed. On revoke, suspend and the kill switch that is a
  // false success on a security control, and typecheck cannot see an ignored
  // return value. So only `import type` may come from the server module.
  function tsxFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "node_modules" ? [] : tsxFiles(path);
      return path.endsWith(".tsx") ? [path] : [];
    });
  }

  it("no .tsx file imports a value from @/app/dashboard/actions", () => {
    const offenders = [...tsxFiles("components"), ...tsxFiles("app")].filter((file) =>
      /^import\s+(?!type\b)[^;]*from\s+["']@\/app\/dashboard\/actions["']/mu.test(readFileSync(file, "utf8"))
    );
    expect(offenders).toEqual([]);
  });
});
