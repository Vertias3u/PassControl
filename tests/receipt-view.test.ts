import { describe, expect, it } from "vitest";
import { verifyReceipt, type VerifyFailure, type VerifyStep } from "@/sdk/verify";
import {
  ALL_FAILURES,
  describeCall,
  describeReceiptAuthentication,
  describeFailover,
  describeFailure,
  describeOwner,
  describeVerdict,
  formatCost,
  formatSignedAt,
  isFetchableIssuer,
  peekArtifact,
  preflight,
  readRecordedEndpoint,
} from "@/lib/verify/receipt-view";

describe("receipt authentication wording", () => {
  it("calls a passport receipt cryptographic passport proof", () => {
    expect(
      describeReceiptAuthentication({ sub: "passport-1", agid: "agent-1" })
    ).toMatchObject({
      label: "Passport verified",
      subjectLabel: "Agent passport",
      subject: "passport-1",
    });
  });

  it("calls a direct receipt bearer possession and never a passport signature", () => {
    const copy = describeReceiptAuthentication({
      sub: "agent-1",
      agid: "agent-1",
      auth: { kind: "direct_key", kid: "key-1", use: "use-1" },
    });
    expect(copy).toMatchObject({
      label: "Direct Agent Key accepted",
      subjectLabel: "Agent identity",
      subject: "agent-1",
      keyId: "key-1",
    });
    expect(copy.detail.toLowerCase()).toContain("bearer");
    expect(copy.detail.toLowerCase()).not.toContain("passport signed");
  });
});

// Presentation for the public receipt page. Pure — no React, no DOM — because
// the judgements encoded here are the ones worth testing, and none of them need
// a browser to be wrong.

describe("failure copy", () => {
  // Hardcoded rather than derived from the module, deliberately. Pinning the
  // module against itself is the mistake PUBLIC_PASSPORT_FIELDS taught: widening
  // both halves together stays green and detects nothing. This list is the
  // change detector — add a VerifyFailure to the SDK and this goes red until
  // someone writes copy for it.
  const EVERY_REASON: VerifyFailure[] = [
    "malformed",
    "untrusted_issuer",
    "unknown_key",
    "bad_signature",
    "wrong_type",
    "unsupported_version",
    "jwks_unreachable",
    "expired",
    "wrong_audience",
    "revoked",
    "status_unavailable",
  ];

  it("covers every failure the verifier can return", () => {
    expect([...ALL_FAILURES].sort()).toEqual([...EVERY_REASON].sort());
    for (const reason of EVERY_REASON) {
      const copy = describeFailure(reason);
      expect(copy.title, reason).toBeTruthy();
      expect(copy.body, reason).toBeTruthy();
    }
  });

  // The whole point of the split. "We could not reach the issuer's key server"
  // and "this signature is forged" are opposite claims, and conflating them
  // either slanders a genuine receipt or launders a forged one.
  it.each([
    ["bad_signature", "forged"],
    ["unknown_key", "forged"],
    ["malformed", "forged"],
    ["wrong_type", "forged"],
    ["jwks_unreachable", "unchecked"],
    ["status_unavailable", "unchecked"],
    ["unsupported_version", "unchecked"],
  ] as const)("classifies %s as %s", (reason, kind) => {
    expect(describeFailure(reason).kind).toBe(kind);
  });

  // An outage is not an accusation. The passport page already draws this line
  // ("This is not a statement that it is invalid"); the wording here must not
  // quietly undo it.
  it("never calls an unchecked receipt invalid or forged", () => {
    for (const reason of EVERY_REASON) {
      const copy = describeFailure(reason);
      if (copy.kind !== "unchecked") continue;
      const text = `${copy.title} ${copy.body}`.toLowerCase();
      for (const accusation of ["forged", "invalid", "not valid", "fake", "tampered"]) {
        expect(text, `${reason} says "${accusation}"`).not.toContain(accusation);
      }
    }
  });

  it("says plainly that an unsupported version means this page is behind, not that the receipt is bad", () => {
    const copy = describeFailure("unsupported_version");
    expect(copy.body.toLowerCase()).toContain("newer");
  });

  // `bad_signature` covers two unrelated conditions in sdk/verify.ts:
  //   alg !== "EdDSA"        — nothing was compared; we never reached a key
  //   ed25519.verify() false — a real signature really did not match
  // Reporting the first with the second's wording accuses a merely-unrecognised
  // artifact of having been tampered with. It is the same mistake the
  // forged/unchecked split exists to prevent, one level finer.
  it("does not claim a signature was compared when the algorithm ruled it out", () => {
    const copy = describeFailure("bad_signature", "algorithm");
    const text = `${copy.title} ${copy.body}`.toLowerCase();
    expect(text).not.toContain("altered");
    expect(text).not.toContain("does not match");
    expect(text).toContain("ed25519");
  });

  it("still says altered when the signature genuinely failed to verify", () => {
    const copy = describeFailure("bad_signature", "signature");
    expect(copy.title.toLowerCase()).toContain("altered");
  });

  it("keeps the signature wording when no step is supplied", () => {
    expect(describeFailure("bad_signature")).toEqual(describeFailure("bad_signature", "signature"));
  });

  it("treats both as something not to rely on", () => {
    expect(describeFailure("bad_signature", "algorithm").kind).toBe("forged");
    expect(describeFailure("bad_signature", "signature").kind).toBe("forged");
  });

  it("ignores the step for reasons that mean one thing only", () => {
    expect(describeFailure("jwks_unreachable", "algorithm")).toEqual(
      describeFailure("jwks_unreachable")
    );
  });

  it("falls back rather than throwing on a reason it has never heard of", () => {
    const copy = describeFailure("something_new" as VerifyFailure);
    expect(copy.kind).toBe("unchecked");
    expect(copy.title).toBeTruthy();
  });
});

describe("peeking at pasted input, before any network call", () => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const jws = (typ: string, iss = "https://issuer.test") =>
    `${b64({ alg: "EdDSA", typ })}.${b64({ iss })}.AAAA`;

  it("recognises a receipt and reports the issuer it claims", () => {
    const peek = peekArtifact(jws("passcontrol-receipt+jwt"));
    expect(peek.kind).toBe("receipt");
    expect(peek.issuer).toBe("https://issuer.test");
  });

  // The most likely real mistake. Telling someone up front beats a network round
  // trip that ends in "wrong_type", which reads like the receipt is broken.
  it("recognises an agent token so the page can say so before verifying", () => {
    expect(peekArtifact(jws("passcontrol-agent+jwt")).kind).toBe("agent_token");
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   \n  "],
    ["a sentence", "hello there"],
    ["two segments", "aaa.bbb"],
    ["four segments", "a.b.c.d"],
    ["undecodable base64", "!!!.???.###"],
    ["valid base64 that is not JSON", `${Buffer.from("nope").toString("base64url")}.x.y`],
    ["a JSON blob", '{"receipt":"eyJ..."}'],
  ])("returns not_jws for %s instead of throwing", (_label, input) => {
    expect(() => peekArtifact(input)).not.toThrow();
    expect(peekArtifact(input).kind).toBe("not_jws");
  });

  it("tolerates the whitespace a copy-paste drags in", () => {
    expect(peekArtifact(`\n  ${jws("passcontrol-receipt+jwt")}  \n`).kind).toBe("receipt");
  });

  it("reports an unknown typ as another artifact rather than guessing", () => {
    expect(peekArtifact(jws("something-else+jwt")).kind).toBe("other_jws");
  });

  // peek runs on UNVERIFIED input. Anything it surfaces is a claim, not a fact,
  // and the page must present it that way.
  it("returns no issuer when the payload does not carry a string one", () => {
    expect(peekArtifact(`${b64({ alg: "EdDSA", typ: "passcontrol-receipt+jwt" })}.${b64({ iss: 42 })}.AAAA`).issuer).toBeNull();
  });
});

describe("what the page can settle without touching the network", () => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const jws = (header: object, payload: object = { iss: "https://issuer.test", ver: 1 }) =>
    `${b64(header)}.${b64(payload)}.AAAA`;
  const RECEIPT_HEADER = { alg: "EdDSA", typ: "passcontrol-receipt+jwt" };

  it("lets a well-formed receipt through to the real verifier", () => {
    expect(preflight(jws(RECEIPT_HEADER))).toBeNull();
  });

  it.each([
    ["gibberish", "not a jws", "parse", "malformed"],
    ["an HS256 token", jws({ alg: "HS256", typ: "passcontrol-receipt+jwt" }), "algorithm", "bad_signature"],
    ["alg:none", jws({ alg: "none", typ: "passcontrol-receipt+jwt" }), "algorithm", "bad_signature"],
    ["an agent token", jws({ alg: "EdDSA", typ: "passcontrol-agent+jwt" }), "type", "wrong_type"],
    ["some other JWS", jws({ alg: "EdDSA", typ: "at+jwt" }), "type", "wrong_type"],
    ["a javascript: issuer", jws(RECEIPT_HEADER, { iss: "javascript:alert(1)" }), "issuer", "untrusted_issuer"],
    ["no issuer at all", jws(RECEIPT_HEADER, { ver: 1 }), "issuer", "untrusted_issuer"],
  ] as const)("stops %s at the %s step", (_label, input, step, reason) => {
    expect(preflight(input)).toEqual({ step, reason });
  });

  // THE guarantee. The page renders one inspection sequence, fed by whichever of
  // preflight or the SDK answered. If they disagreed, the page would show a check
  // failing at a point the real verifier never fails at — and every duration
  // beside it would describe something that never ran. So this does not compare
  // preflight to a second copy of my assumptions; it runs the real verifier and
  // compares.
  it.each([
    ["gibberish", "not a jws"],
    ["an HS256 token", jws({ alg: "HS256", typ: "passcontrol-receipt+jwt" })],
    ["an agent token", jws({ alg: "EdDSA", typ: "passcontrol-agent+jwt" })],
    ["some other JWS", jws({ alg: "EdDSA", typ: "at+jwt" })],
  ])("agrees with sdk/verify.ts about where %s fails", async (_label, input) => {
    const local = preflight(input);
    expect(local).not.toBeNull();

    const steps: VerifyStep[] = [];
    const result = await verifyReceipt(input, {
      trustedIssuers: ["https://issuer.test"],
      onStep: (s) => steps.push(s),
      fetch: (() => {
        throw new Error("preflight should have stopped this before any network call");
      }) as unknown as typeof fetch,
    });

    expect(steps.at(-1)!.step).toBe(local!.step);
    expect(steps.at(-1)!.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe(local!.reason);
  });
});

describe("cost, on a document that is a financial record", () => {
  // The trap this exists to close: cost is in microcents, and the obvious
  // conversion prints "$0.0000" for a real, non-zero charge.
  it("never rounds a real charge down to nothing", () => {
    const small = formatCost(61);
    expect(small.primary).not.toMatch(/^\$0\.0000$/);
    expect(small.primary).toBe("Under $0.0001");
    expect(small.exact).toContain("61");
  });

  it.each([
    [0, "No charge recorded"],
    [300_000, "$0.0030"],
    [5_000_000, "$0.05"],
    [1_234_000_000, "$12.34"],
  ])("renders %d microcents as %s", (microcents, expected) => {
    expect(formatCost(microcents).primary).toBe(expected);
  });

  it("keeps the exact signed figure available for anyone who needs it", () => {
    expect(formatCost(1_234_000_000).exact).toBe("1,234,000,000 microcents recorded");
  });

  it("says nothing was recorded rather than inventing a zero", () => {
    expect(formatCost(Number.NaN).primary).toBe("Not recorded");
    expect(formatCost(-5).primary).toBe("Not recorded");
    expect(formatCost(0).exact).toBeNull();
  });
});

describe("which issuers the page will fetch keys from", () => {
  // The page trusts the issuer the receipt names — that is what makes it work
  // for self-hosters. But "trust the name" must never become "hand an arbitrary
  // string to fetch()".
  it.each([
    "https://passcontrol.vertias.eu",
    "https://gateway.acme.co.uk",
    "https://passcontrol.vertias.eu/",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ])("accepts %s", (issuer) => {
    expect(isFetchableIssuer(issuer)).toBe(true);
  });

  it.each([
    ["a null issuer", null],
    ["an empty string", ""],
    ["not a url at all", "passcontrol.vertias.eu"],
    ["a javascript url", "javascript:alert(1)"],
    ["a data url", "data:text/plain,hi"],
    ["a file url", "file:///etc/passwd"],
    ["routable http", "http://passcontrol.vertias.eu"],
    ["credentials in the userinfo", "https://user:pass@passcontrol.vertias.eu"],
    ["a path", "https://passcontrol.vertias.eu/tenant-a"],
    ["a query string", "https://passcontrol.vertias.eu/?next=https://evil.test"],
    ["a fragment", "https://passcontrol.vertias.eu/#x"],
  ])("rejects %s", (_label, issuer) => {
    expect(isFetchableIssuer(issuer)).toBe(false);
  });
});

describe("the verdict a receipt records", () => {
  it("reads as plain English, not board jargon", () => {
    const verdict = describeVerdict("blocked_scope", 403);
    // The departures board says "NO VISA" — right for an operator watching a
    // fleet, wrong for a stranger's finance manager reading one receipt.
    expect(verdict.label).not.toMatch(/NO VISA/i);
    expect(verdict.label.toLowerCase()).toContain("refus");
    expect(verdict.detail).toBeTruthy();
  });

  it("marks a successful call as allowed", () => {
    expect(describeVerdict("ok", 200).tone).toBe("clear");
  });

  // VERDICTS is Record<string, …> on purpose, so the compiler cannot catch a
  // missing entry the way it does for the departures board. This is that guard.
  it("recognises a provider-credit refusal, and never calls it over budget", () => {
    const verdict = describeVerdict("provider_exhausted", 402);
    expect(verdict.label).not.toMatch(/recorded as/i);
    // Same HTTP status as blocked_budget, opposite meaning. The reader is a
    // counterparty reconciling a bill: telling them the agent hit its own
    // spending limit, when the provider's account was empty, is a wrong answer
    // about whose money ran out.
    expect(verdict.label).not.toMatch(/over budget/i);
    expect(verdict.detail).toMatch(/provider/i);
    expect(verdict.detail).not.toMatch(/spending limit/i);
  });

  it.each(["blocked_suspended", "blocked_killed"])("treats %s as a hard denial", (status) => {
    expect(describeVerdict(status, 403).tone).toBe("denied");
  });

  it("shows an unrecognised status as itself rather than mislabelling it", () => {
    const verdict = describeVerdict("blocked_something_new", 403);
    expect(verdict.label).toContain("blocked_something_new");
    expect(verdict.tone).toBe("held");
  });
});

describe("the call line", () => {
  it("reads method, path, provider and model", () => {
    expect(
      describeCall({ mth: "POST", path: "v1/messages", prov: "anthropic", mdl: "claude-sonnet-4-5" })
    ).toBe("POST v1/messages → anthropic/claude-sonnet-4-5");
  });

  it("omits the model when the call never named one", () => {
    expect(describeCall({ mth: "POST", path: "v1/messages", prov: "anthropic", mdl: null })).toBe(
      "POST v1/messages → anthropic"
    );
  });
});

describe("the owner claim", () => {
  // The rule the whole ladder rests on, restated on the one surface a stranger
  // reads. `kind` is the method attempted; `tier` is what was actually proven.
  it("never reads a self-attested claim as verified, whatever kind says", () => {
    const owner = describeOwner({ kind: "domain", sub: "acme.com", tier: "unverified", vat: null });
    expect(owner!.verified).toBe(false);
    expect(owner!.note.toLowerCase()).toContain("not verified");
  });

  it("marks a domain-verified owner as verified", () => {
    const owner = describeOwner({
      kind: "domain",
      sub: "acme.com",
      tier: "domain",
      vat: "2026-07-01T00:00:00.000Z",
    });
    expect(owner!.verified).toBe(true);
    expect(owner!.note).toContain("1 July 2026");
  });

  it("is absent when the receipt carries no owner", () => {
    expect(describeOwner(undefined)).toBeNull();
    expect(describeOwner(null)).toBeNull();
  });

  it("treats an unknown tier as unproven rather than as proven", () => {
    const owner = describeOwner({ kind: "domain", sub: "acme.com", tier: "platinum", vat: null });
    expect(owner!.verified).toBe(false);
  });
});

describe("timestamps", () => {
  it("renders the signing time in UTC, which is what the claim records", () => {
    expect(formatSignedAt(1785925292)).toMatch(/2026/);
    expect(formatSignedAt(1785925292)).toMatch(/UTC/);
  });

  it("does not invent a date for a missing or absurd value", () => {
    expect(formatSignedAt(0)).toBe("Not recorded");
    expect(formatSignedAt(Number.NaN)).toBe("Not recorded");
  });
});

describe("the failover chain", () => {
  // `why` is the claim that makes the double-billing exposure legible. It is
  // rendered for a reader who may be holding two bills for one request and
  // needs to know whether that is expected.
  it("names each reason in words a stranger can act on", () => {
    for (const why of ["credit_exhausted", "rate_limited", "upstream_5xx", "unreachable"]) {
      const f = describeFailover(why)!;
      expect(f.label).toBeTruthy();
      expect(f.detail).toBeTruthy();
      expect(f.label).not.toBe(why);
      expect(f.recognised).toBe(true);
    }
  });

  // The split that matters. After a 5xx or a dropped connection the provider
  // may already have RUN the call and billed it; the gateway cannot tell. A
  // reader reconciling invoices has to be told which case they are in.
  it("says plainly when the earlier attempt may already have been charged", () => {
    for (const why of ["upstream_5xx", "unreachable"]) {
      expect(describeFailover(why)!.mayHaveBeenCharged).toBe(true);
      expect(describeFailover(why)!.detail).toMatch(/may (already )?have|might already/i);
    }
    for (const why of ["credit_exhausted", "rate_limited"]) {
      expect(describeFailover(why)!.mayHaveBeenCharged).toBe(false);
    }
  });

  // The receipt is signed by whatever issuer the reader chose to trust — not
  // necessarily this deployment, and not necessarily this version of it. An
  // unknown reason must be shown as itself, never resolved to a friendly
  // wording that is a guess, and never resolved to "nothing was charged".
  it("shows an unrecognised reason as itself, and does not vouch for the billing", () => {
    const f = describeFailover("some_future_reason")!;
    expect(f.label).toContain("some_future_reason");
    expect(f.recognised).toBe(false);
    expect(f.mayHaveBeenCharged).toBe(true);
  });

  it("ignores a reason that is not a string", () => {
    for (const value of [null, undefined, 42, {}, ""]) {
      expect(describeFailover(value)).toBeNull();
    }
  });

  // A failed attempt records cost 0 because that is what the provider REPORTED,
  // not because the gateway knows nothing was spent. The wording on the zero
  // must not close a question the receipt cannot answer.
  it("never lets a zero cost read as a guarantee that nothing was charged", () => {
    expect(formatCost(0).primary).not.toMatch(/free|no charge for|nothing/i);
    expect(formatCost(0).primary.toLowerCase()).toContain("recorded");
  });
});

// ── Reading the endpoint back off a stored row ───────────────────────────────
//
// Every row carries `mth` + `path` inside its signed receipt — including refused
// ones, because logBlocked builds a receipt too. Nothing surfaced it, so a board
// full of NO ROUTE told an operator nothing about which route. This reads it for
// display only: the claims are UNVERIFIED here, and the wording must never let a
// decoded claim pass as an asserted fact (the forged-receipt lesson).
describe("recorded endpoint, read from an unverified receipt", () => {
  const jws = (claims: Record<string, unknown>) => {
    const seg = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${seg({ alg: "EdDSA", typ: "application/passcontrol-receipt+jwt" })}.${seg(claims)}.c2ln`;
  };

  it("reads the method and path a receipt records", () => {
    expect(readRecordedEndpoint(jws({ mth: "POST", path: "v1/messages" })))
      .toBe("POST /v1/messages");
  });

  it("keeps a path that already has a leading slash from doubling it", () => {
    expect(readRecordedEndpoint(jws({ mth: "GET", path: "/v1/models" })))
      .toBe("GET /v1/models");
  });

  it("returns null when there is no receipt to read", () => {
    expect(readRecordedEndpoint(null)).toBeNull();
    expect(readRecordedEndpoint("")).toBeNull();
  });

  it("returns null rather than a half-answer on a malformed receipt", () => {
    expect(readRecordedEndpoint("not.a.jws")).toBeNull();
    expect(readRecordedEndpoint(jws({ mth: "POST" }))).toBeNull();
    expect(readRecordedEndpoint(jws({ path: "v1/messages" }))).toBeNull();
  });

  it("refuses claim values that are not strings", () => {
    // A receipt is attacker-influenceable input until a signature says otherwise.
    expect(readRecordedEndpoint(jws({ mth: { $: 1 }, path: "v1/messages" }))).toBeNull();
    expect(readRecordedEndpoint(jws({ mth: "POST", path: ["v1", "messages"] }))).toBeNull();
  });

  it("bounds and sanitises what it will render", () => {
    // Rendered into the dashboard, so it may not carry control characters or an
    // unbounded string out of a payload nobody has verified.
    expect(readRecordedEndpoint(jws({ mth: "POST", path: "v1/mes\nsages" })))
      .toBe("POST /v1/mes sages");
    const long = readRecordedEndpoint(jws({ mth: "POST", path: "a".repeat(500) }));
    expect(long!.length).toBeLessThanOrEqual(128);
  });
});
