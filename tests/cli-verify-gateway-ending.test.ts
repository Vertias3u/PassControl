import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { publicJwk } from "@/lib/crypto/instanceKey";
import { RECEIPT_TYP, signCompactJws } from "@/lib/crypto/jws";

const run = promisify(execFile);
const seed = new Uint8Array(32).fill(9);
const key = publicJwk(ed25519.getPublicKey(seed));
// Stub only transport in the real CLI process. No listener or dev server needed.
const preload = `data:text/javascript,${encodeURIComponent(`globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify({ keys: [key] }))});`)}`;
it.each([["kill_switch", "kill switch"], ["session", "session stop"], ["service", "service stop"], ["mission_end", "mission end"], ["budget_pause", "budget pause line"]])(
  "the CLI prints %s as an owner stop with no agent credential", async (trigger, label) => {
    const issuer = "https://gateway.example";
    const token = signCompactJws({ typ: RECEIPT_TYP, kid: key.kid, seed, claims: {
      iss: issuer, sub: "gateway", jti: "receipt-1", iat: 1700000000, agid: "agent-1",
      prov: "svc:github", mdl: null, mth: "POST", path: "repos/acme/web/actions/runs/42/cancel",
      use: { in: 0, out: 0 }, cost: 0, cls: "svc", res: { status: "ok", http: 202 },
      t0: 1700000000000, lat: 25, ver: 4, auth: { kind: "gateway_ending" },
      end: { thg: "thing-1", knd: "github_workflow_run", trg: trigger, sat: 1700000000 },
    } });
    const taskHome = mkdtempSync(join(tmpdir(), "pc-ending-"));
    const { stdout } = await run(process.execPath, ["--import", preload, "bin/passcontrol.mjs", "verify", "receipt", token, "--issuer", issuer], {
      env: { PATH: process.env.PATH ?? "", HOME: taskHome, XDG_CONFIG_HOME: taskHome, NO_COLOR: "1", CI: "1", NODE_ENV: "test" },
    });
    expect(stdout).toContain("Receipt is valid.");
    expect(stdout).toContain(`Ended by PassControl on the owner's stop (${label}), not a call by the agent. No passport or agent key signed it.`);
    expect(stdout).not.toMatch(/Passport:|passport-signed|agent called/i);
  }
);
