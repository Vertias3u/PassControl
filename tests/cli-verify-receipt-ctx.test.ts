// `passcontrol verify receipt` shows the session and sub-agent a call DECLARED, and
// says that it was declared (sprint Q5, Bet A). A reader must never come away
// thinking the passport proved which sub-agent made the call.
//
// Runs the real CLI against a local JWKS server: verification needs the issuer's
// published key, and this is the path a stranger actually runs.
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bytesToBase64url } from "@/lib/encoding";
import { loadInstanceSigner, publicJwk } from "@/lib/crypto/instanceKey";
import { RECEIPT_TYP, signCompactJws } from "@/lib/crypto/jws";

const run = promisify(execFile);
let server: Server;
let origin = "";

beforeAll(async () => {
  process.env.INSTANCE_SIGNING_KEY = bytesToBase64url(new Uint8Array(32).fill(5));
  const signer = loadInstanceSigner()!;
  server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [publicJwk(signer.publicKey)] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function receipt(ctx?: Record<string, unknown>) {
  const signer = loadInstanceSigner()!;
  return signCompactJws({
    typ: RECEIPT_TYP,
    kid: signer.kid,
    seed: signer.seed,
    claims: {
      iss: origin,
      sub: "passport-id",
      jti: "r-1",
      iat: 1_791_000_000,
      agid: "agent-1",
      prov: "anthropic",
      mdl: "claude-haiku-4-5",
      mth: "POST",
      path: "v1/messages",
      use: { in: 1, out: 1 },
      cost: 1,
      res: { status: "ok", http: 200 },
      t0: 1_791_000_000_000,
      lat: 1,
      ver: 1,
      ...(ctx ? { ctx } : {}),
    },
  });
}

async function verify(jws: string) {
  const home = mkdtempSync(join(tmpdir(), "pc-verify-"));
  const { stdout } = await run(process.execPath, ["bin/passcontrol.mjs", "verify", "receipt", jws, "--issuer", origin], {
    env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: home, NO_COLOR: "1", CI: "1" } as unknown as NodeJS.ProcessEnv,
  });
  return stdout;
}

describe("the declared session line", () => {
  it("names a sub-agent and its parent, and says the client declared them", async () => {
    const out = await verify(receipt({ src: "declared", cli: "claude-code", ses: "s-1", agt: "a-2", par: "a-1" }));
    expect(out).toContain("Receipt is valid.");
    expect(out).toMatch(/Session:\s+s-1/);
    expect(out).toContain("sub-agent a-2, spawned by a-1");
    expect(out).toContain("declared by the client (claude-code), not verified");
  });

  it("names the main agent when no sub-agent was declared", async () => {
    const out = await verify(receipt({ src: "declared", cli: "codex", ses: "s-1" }));
    expect(out).toContain("main agent");
  });

  it("prints nothing about sessions for a receipt without ctx", async () => {
    expect(await verify(receipt())).not.toContain("Session:");
  });

  it("cannot be used to write escape sequences to the reader's terminal", async () => {
    const out = await verify(receipt({ src: "declared", cli: "claude-code", ses: "s\u001b[2J-1", agt: "a\nForged: line" }));
    expect(out).not.toContain("\u001b[2J");
    expect(out).not.toMatch(/\nForged: line/);
  });
});
