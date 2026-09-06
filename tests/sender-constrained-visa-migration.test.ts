import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "db/migrations/0046_sender_constrained_visas.sql"),
  "utf8"
);

describe("sender-constrained visa migration", () => {
  it("adds a per-agent opt-in that is off for every existing and new agent", () => {
    expect(migration).toMatch(
      /alter table public\.agents\s+add column require_sender_constrained_visa boolean not null default false/i
    );
    expect(migration).not.toMatch(/default true/i);
  });

  it("does not make the trust-boundary flag directly writable by dashboard clients", () => {
    expect(migration).not.toMatch(/grant update[\s\S]*require_sender_constrained_visa[\s\S]*authenticated/i);
  });
});
