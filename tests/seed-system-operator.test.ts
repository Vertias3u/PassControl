import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
// @ts-expect-error - plain ESM setup script, intentionally untyped
import { recordSystemOperator, withSystemOperator } from "../scripts/seed.mjs";

// Self-host is one developer on localhost (owner, 2026-10-05). System Health
// authorizes only the emails in PASSCONTROL_SYSTEM_OPERATOR_EMAILS, and the
// local stack used to leave that empty, so the one person who runs the instance
// could never open the page that diagnoses it. The seed now names the account
// it just created. A permissive default in the self-host env file, never in a
// code default: lib/system-health/operator.ts still fails closed when unset.

const LINE = "PASSCONTROL_SYSTEM_OPERATOR_EMAILS";

describe("withSystemOperator", () => {
  it("fills an empty operator list with the seeded account", () => {
    const env = `A=1\n${LINE}=\nB=2\n`;
    expect(withSystemOperator(env, "Dev@PassControl.local ")).toBe(
      `A=1\n${LINE}=dev@passcontrol.local\nB=2\n`
    );
  });

  it("appends the line when the file has none", () => {
    expect(withSystemOperator("A=1\n", "dev@passcontrol.local")).toBe(
      `A=1\n${LINE}=dev@passcontrol.local\n`
    );
    expect(withSystemOperator("A=1", "dev@passcontrol.local")).toBe(
      `A=1\n${LINE}=dev@passcontrol.local\n`
    );
  });

  it("never overrides an operator list someone already set", () => {
    const env = `${LINE}=owner@example.com\n`;
    expect(withSystemOperator(env, "dev@passcontrol.local")).toBe(env);
  });

  it("refuses a value that could write a second env line", () => {
    const env = `${LINE}=\n`;
    for (const bad of ["a@b.c\nKILL_SWITCH_FAIL_CLOSED=false", "a b@c.d", "not-an-email", ""]) {
      expect(withSystemOperator(env, bad), JSON.stringify(bad)).toBe(env);
    }
  });
});

describe("recordSystemOperator", () => {
  it("writes the filled list back and says so", () => {
    let written = "";
    const result = recordSystemOperator(".env.docker", "dev@passcontrol.local", {
      read: () => "PASSCONTROL_SYSTEM_OPERATOR_EMAILS=\n",
      write: (_path: string, text: string) => { written = text; },
    });
    expect(result).toBe("added");
    expect(written).toBe("PASSCONTROL_SYSTEM_OPERATOR_EMAILS=dev@passcontrol.local\n");
  });

  it("leaves the file alone when nothing changes", () => {
    let wrote = false;
    const result = recordSystemOperator(".env.docker", "dev@passcontrol.local", {
      read: () => "PASSCONTROL_SYSTEM_OPERATOR_EMAILS=owner@example.com\n",
      write: () => { wrote = true; },
    });
    expect(result).toBe("unchanged");
    expect(wrote).toBe(false);
  });

  // A convenience must never fail first-run setup: dev-stack.sh runs under
  // `set -e`, so a throw here would abort `passcontrol setup` after the
  // account already exists.
  it("reports a failure instead of throwing when the file cannot be read or written", () => {
    const unreadable = recordSystemOperator(".env.docker", "dev@passcontrol.local", {
      read: () => { throw new Error("ENOENT"); },
      write: () => {},
    });
    expect(unreadable).toBe("failed");
    const unwritable = recordSystemOperator(".env.docker", "dev@passcontrol.local", {
      read: () => "",
      write: () => { throw new Error("EACCES"); },
    });
    expect(unwritable).toBe("failed");
  });
});

describe("the local stack wires it up", () => {
  it("hands the seed the env file and carries the list across regenerations", async () => {
    const script = await readFile(new URL("../scripts/dev-stack.sh", import.meta.url), "utf8");
    const preserve = script.slice(script.indexOf('if [[ -f "$ENVF" ]]'), script.indexOf('cat > "$ENVF"'));
    const heredoc = script.slice(script.indexOf('cat > "$ENVF"'), script.indexOf("\nEOF"));

    // `passcontrol update` regenerates .env.docker but skips the seed, so a value
    // only the seed writes would vanish on every update without this.
    expect(preserve).toContain(`${LINE}=$(grep '^${LINE}=' "$ENVF" | cut -d= -f2- || true)`);
    expect(heredoc).toContain(`${LINE}=$${LINE}`);
    // Relative, not "$ENVF": the script runs from the repo root, and Git Bash on
    // Windows converts POSIX paths in arguments but not in environment values.
    expect(script).toContain("PASSCONTROL_ENV_FILE=.env.docker node scripts/seed.mjs");
  });
});
