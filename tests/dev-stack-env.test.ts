import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { instanceIssuer, loadInstanceSigner, loadInstanceVerifiers } from "@/lib/crypto/instanceKey";

// scripts/dev-stack.sh REGENERATES .env.docker from scratch on every run. Any
// secret it does not explicitly carry forward is silently replaced, and the
// operator has no way to notice — the stack comes up clean either way.
//
// For VISA_SECRET that is survivable: visas live 5 minutes, so a rotation heals
// itself before anyone files a bug. INSTANCE_SIGNING_KEY is the opposite case
// and is the reason this file exists:
//
//   A receipt has no `exp`. It is a permanent historical record, verified by
//   fetching the issuer's JWKS and matching `kid`. Regenerate the seed and the
//   old public key is gone from that key set forever — so EVERY receipt ever
//   signed by this stack stops verifying, all at once, with no error anywhere
//   pointing at the cause. The artifacts are intact; the key that proves them
//   is not.
//
// That is a worse failure than losing the key outright, because it is silent.
// Hence: preserved across runs, generated per install, never a constant.
const script = await readFile(new URL("../scripts/dev-stack.sh", import.meta.url), "utf8");
const template = await readFile(new URL("../.env.docker.example", import.meta.url), "utf8");

const original = {
  issuer: process.env.PASSCONTROL_ISSUER,
  key: process.env.INSTANCE_SIGNING_KEY,
  prev: process.env.INSTANCE_SIGNING_KEY_PREV,
};
const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
afterEach(() => {
  restore("PASSCONTROL_ISSUER", original.issuer);
  restore("INSTANCE_SIGNING_KEY", original.key);
  restore("INSTANCE_SIGNING_KEY_PREV", original.prev);
});

// Exactly what the script's `gen()` emits: `openssl rand -base64 32`. That is
// STANDARD base64 — it can contain `+`, `/` and `=` padding, none of which are
// base64url characters. The generator and the loader were written separately;
// these two tests are the only thing checking they agree.
const genLikeTheScript = () => randomBytes(32).toString("base64");

// The block that reads the previous .env.docker back, before the heredoc
// overwrites it. A key named only in the heredoc is regenerated every run.
const preserveBlock = script.slice(
  script.indexOf('if [[ -f "$ENVF" ]]'),
  script.indexOf("cat > \"$ENVF\"")
);
const heredoc = script.slice(script.indexOf("cat > \"$ENVF\""), script.indexOf("\nEOF"));

describe("the local stack's instance signing key", () => {
  it("is written into the generated env at all, or receipts are silently off", () => {
    // With no signing key, loadInstanceSigner() returns null, writeLog omits the
    // receipt column, and the proxy behaves byte-identically to before the
    // feature existed. The stack looks healthy and proves nothing.
    expect(heredoc).toMatch(/^INSTANCE_SIGNING_KEY=/m);
  });

  it("is carried forward from a previous run, not minted afresh each time", () => {
    expect(preserveBlock).toContain("INSTANCE_SIGNING_KEY");
  });

  it("is generated per install rather than shipped as a constant", () => {
    // Same lesson as the retired `passcontrol-dev` password: a checked-in seed
    // is the same signing key on every machine on earth, so anyone could forge
    // receipts for anyone else's stack. There must be no literal seed here.
    expect(script).toMatch(/INSTANCE_SIGNING_KEY=\$\{?INSTANCE_SIGNING_KEY/);
    expect(script).not.toMatch(/INSTANCE_SIGNING_KEY=[A-Za-z0-9+/_-]{20,}/);
  });

  // Run enough samples that a padding- or alphabet-dependent bug cannot slip
  // through on a lucky draw — roughly 3 in 4 random 32-byte values contain a
  // `+` or `/`, so a single sample would miss it often.
  it("produces a seed the loader accepts, in the alphabet openssl emits", () => {
    for (let i = 0; i < 40; i++) {
      const seed = genLikeTheScript();
      process.env.INSTANCE_SIGNING_KEY = seed;
      const signer = loadInstanceSigner();
      expect(signer, `dev-stack.sh would have written an unusable seed: ${seed}`).not.toBeNull();
      expect(signer!.kid).toBeTruthy();
    }
  });

  it("publishes exactly one key when _PREV is written as an empty string", () => {
    // The generator always writes the _PREV line, empty until a real rotation.
    // An empty value must read as "no key", not as a malformed one that drops
    // the whole key set and takes the current key down with it.
    process.env.INSTANCE_SIGNING_KEY = genLikeTheScript();
    process.env.INSTANCE_SIGNING_KEY_PREV = "";
    expect(loadInstanceVerifiers()).toHaveLength(1);
  });

  it("keeps the previous public key available so old receipts still verify", () => {
    // INSTANCE_SIGNING_KEY_PREV is what makes a rotation survivable: its public
    // half stays in the JWKS even though nothing signs with it any more. If the
    // stack ever does rotate the seed, this is the only thing standing between
    // that and the silent mass-invalidation described at the top of this file.
    expect(preserveBlock).toContain("INSTANCE_SIGNING_KEY_PREV");
    expect(heredoc).toMatch(/^INSTANCE_SIGNING_KEY_PREV=/m);
  });
});

describe("the local stack's issuer", () => {
  it("is written into the generated env", () => {
    expect(heredoc).toMatch(/^PASSCONTROL_ISSUER=/m);
  });

  // Not a style check. instanceIssuer() returns null for anything that is not an
  // https origin or a LOOPBACK http one, and a null issuer means no receipts and
  // a 501 from the agent-token route. A wrong value here disables the feature as
  // completely as omitting it.
  it("writes an origin that instanceIssuer() actually accepts", () => {
    const written = heredoc.match(/^PASSCONTROL_ISSUER=(.+)$/m)?.[1] ?? "";
    expect(written).toBeTruthy();

    const resolved = written.replace(/\$\{PORT:-(\d+)\}/, "$1").replace(/\$PORT\b/, "3000");
    expect(resolved).not.toContain("$");

    process.env.PASSCONTROL_ISSUER = resolved;
    expect(instanceIssuer()).toBe(resolved);
  });
});

describe("the committed template", () => {
  // .env.docker.example is the documented starting point for a self-host and
  // ships in the public mirror. A generated env that carries keys the template
  // never mentions is how a self-hoster ends up not knowing the feature exists.
  it("documents the keys the generator writes", () => {
    for (const key of ["INSTANCE_SIGNING_KEY", "PASSCONTROL_ISSUER"]) {
      expect(template, `.env.docker.example does not mention ${key}`).toContain(key);
    }
  });
});
