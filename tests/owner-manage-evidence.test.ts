import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  upsertMock: vi.fn(),
  updateMock: vi.fn(),
  purgeMock: vi.fn(),
  verifyDomainMock: vi.fn(),
  verifyGithubMock: vi.fn(),
  lookupCompanyMock: vi.fn(),
}));

vi.mock("@/lib/state/redis", () => ({ purgeOwnerCache: (...a: unknown[]) => h.purgeMock(...a) }));
vi.mock("@/lib/owner/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/owner/domain")>();
  return { ...actual, verifyDomainControl: (...a: unknown[]) => h.verifyDomainMock(...a) };
});
vi.mock("@/lib/owner/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/owner/github")>();
  return { ...actual, verifyGithubControl: (...a: unknown[]) => h.verifyGithubMock(...a) };
});
vi.mock("@/lib/owner/company", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/owner/company")>();
  return { ...actual, lookupCompany: (...a: unknown[]) => h.lookupCompanyMock(...a) };
});

import {
  OWNER_FAILURE_LIMIT,
  clearOwnerCompany,
  setOwner,
  setOwnerCompany,
  verifyOwnerControl,
} from "@/lib/owner/manage";

let selected: { data: unknown; error: unknown } = { data: null, error: null };
const eqCalls: [string, unknown][] = [];

function db() {
  const b: any = {
    select: () => b,
    eq: (col: string, val: unknown) => {
      eqCalls.push([col, val]);
      return b;
    },
    upsert: (row: unknown) => {
      h.upsertMock(row);
      return b;
    },
    update: (patch: unknown) => {
      h.updateMock(patch);
      return b;
    },
    maybeSingle: async () => selected,
  };
  return { from: () => b } as never;
}

const GITHUB_ROW = {
  kind: "github",
  subject: "octocat",
  tier: "unverified",
  published: false,
  verification_token: "passcontrol-verify-tok",
  verified_at: null,
  last_checked_at: null,
  failure_count: 0,
  company_id: null,
  company_source: null,
  company_name: null,
  company_jurisdiction: null,
  company_active: null,
  company_checked_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  eqCalls.length = 0;
  selected = { data: GITHUB_ROW, error: null };
  h.purgeMock.mockResolvedValue(undefined);
});

describe("declaring a GitHub owner", () => {
  it("lands at tier unverified with a fresh token, exactly like a domain", async () => {
    await setOwner(db(), "u1", { kind: "github", subject: "OctoCat", published: true });
    const row = h.upsertMock.mock.calls[0]![0];
    expect(row).toMatchObject({ kind: "github", tier: "unverified", verified_at: null });
    // Claiming an account and proving control of it are two different acts, and
    // only the second moves the tier.
    expect(row.verification_token).toMatch(/^passcontrol-verify-/u);
  });

  // GitHub logins are unique case-insensitively, and the raw host serves the
  // proof under any casing. Storing the casing the owner happened to type would
  // make the stored subject and the verified path disagree on sight.
  it("normalises the login to lower case", async () => {
    await setOwner(db(), "u1", { kind: "github", subject: "OctoCat" });
    expect(h.upsertMock.mock.calls[0]![0].subject).toBe("octocat");
  });

  it("refuses a login it could never build a URL from", async () => {
    const result = await setOwner(db(), "u1", { kind: "github", subject: "octocat/../etc" });
    expect(result).toMatchObject({ ok: false, status: 400, code: "invalid_login" });
    expect(h.upsertMock).not.toHaveBeenCalled();
  });

  // The quiet mistake: a domain typed into the GitHub field fails the login
  // regex on its dots, and "invalid login" sends the owner looking for a typo in
  // a string that is perfectly valid — just of the other kind.
  it("says a domain is a domain rather than calling it a malformed login", async () => {
    const result = await setOwner(db(), "u1", { kind: "github", subject: "acme.com" });
    expect(result).toMatchObject({ ok: false, code: "looks_like_domain" });
  });

  it("still ignores a caller-supplied tier", async () => {
    await setOwner(db(), "u1", { kind: "github", subject: "octocat", tier: "github" });
    expect(h.upsertMock.mock.calls[0]![0].tier).toBe("unverified");
  });
});

describe("verifying control, whichever kind it is", () => {
  it("promotes a proven GitHub account to tier github", async () => {
    h.verifyGithubMock.mockResolvedValue({ ok: true });
    const result = await verifyOwnerControl(db(), "u1", { now: () => new Date("2026-09-01T00:00:00Z") });

    expect(h.verifyGithubMock).toHaveBeenCalledWith("octocat", "passcontrol-verify-tok", {});
    expect(h.updateMock.mock.calls[0]![0]).toMatchObject({
      tier: "github",
      verified_at: "2026-09-01T00:00:00.000Z",
      failure_count: 0,
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("routes a domain owner to the domain check and never to GitHub", async () => {
    selected = { data: { ...GITHUB_ROW, kind: "domain", subject: "acme.com" }, error: null };
    h.verifyDomainMock.mockResolvedValue({ ok: true });
    await verifyOwnerControl(db(), "u1");

    expect(h.verifyDomainMock).toHaveBeenCalledOnce();
    expect(h.verifyGithubMock).not.toHaveBeenCalled();
    expect(h.updateMock.mock.calls[0]![0]).toMatchObject({ tier: "domain" });
  });

  it("refuses a self-attested owner, which has nothing to check", async () => {
    selected = { data: { ...GITHUB_ROW, kind: "self_attested", subject: "Acme" }, error: null };
    await expect(verifyOwnerControl(db(), "u1")).resolves.toMatchObject({
      ok: false,
      code: "not_verifiable_kind",
    });
  });

  // The compare-and-set 0017's module documents: the result belongs to the claim
  // that was actually checked, and a re-declaration during the fetch replaces
  // both subject and token.
  it("conditions the write on the exact claim it checked", async () => {
    h.verifyGithubMock.mockResolvedValue({ ok: true });
    await verifyOwnerControl(db(), "u1");
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        ["user_id", "u1"],
        ["kind", "github"],
        ["subject", "octocat"],
        ["verification_token", "passcontrol-verify-tok"],
      ])
    );
  });

  it("spends a strike when GitHub answers and the proof is not there", async () => {
    selected = { data: { ...GITHUB_ROW, tier: "github", failure_count: 0 }, error: null };
    h.verifyGithubMock.mockResolvedValue({ ok: false, reason: "not_published" });
    await verifyOwnerControl(db(), "u1");
    expect(h.updateMock.mock.calls[0]![0]).toMatchObject({ failure_count: 1 });
  });

  // The asymmetry that must not be homogenised with the domain module's. For a
  // domain, `unreachable` is the OWNER'S web server not answering, and three of
  // those in a row genuinely is a claim that no longer holds. For GitHub it is a
  // CDN neither we nor the owner operates, so spending strikes on it would
  // demote a perfectly valid binding for somebody else's outage.
  it("does not spend a strike when GitHub itself is unreachable", async () => {
    selected = { data: { ...GITHUB_ROW, tier: "github", failure_count: 2 }, error: null };
    h.verifyGithubMock.mockResolvedValue({ ok: false, reason: "unreachable" });
    await verifyOwnerControl(db(), "u1");

    const patch = h.updateMock.mock.calls[0]![0];
    expect(patch).not.toHaveProperty("failure_count");
    expect(patch).not.toHaveProperty("tier");
    expect(patch).toHaveProperty("last_checked_at");
  });

  it("still demotes an unreachable DOMAIN after the limit, as before", async () => {
    selected = {
      data: { ...GITHUB_ROW, kind: "domain", subject: "acme.com", tier: "domain", failure_count: OWNER_FAILURE_LIMIT - 1 },
      error: null,
    };
    h.verifyDomainMock.mockResolvedValue({ ok: false, reason: "unreachable" });
    await verifyOwnerControl(db(), "u1");
    expect(h.updateMock.mock.calls[0]![0]).toMatchObject({
      failure_count: OWNER_FAILURE_LIMIT,
      tier: "unverified",
    });
  });
});

describe("the company line", () => {
  it("records a resolved register entry without touching the proof", async () => {
    selected = { data: { ...GITHUB_ROW, tier: "github", verified_at: "2026-08-01T00:00:00.000Z" }, error: null };
    h.lookupCompanyMock.mockResolvedValue({
      ok: true,
      name: "ACME LIMITED",
      jurisdiction: "IE",
      active: true,
    });

    const result = await setOwnerCompany(db(), "u1", "IE 6388047 V", {
      now: () => new Date("2026-09-01T00:00:00Z"),
    });

    expect(result).toMatchObject({ ok: true });
    const patch = h.updateMock.mock.calls[0]![0];
    expect(patch).toEqual({
      company_id: "IE6388047V",
      company_source: "vat",
      company_name: "ACME LIMITED",
      company_jurisdiction: "IE",
      company_active: true,
      company_checked_at: "2026-09-01T00:00:00.000Z",
    });
  });

  // The rule migration 0048 exists to protect. A register lookup is not a proof
  // of anything about this tenant, so it may never move the label that says what
  // WAS proven — in either direction.
  it("never writes tier, verified_at, kind, subject or failure_count", async () => {
    h.lookupCompanyMock.mockResolvedValue({ ok: true, name: "ACME", jurisdiction: "IE", active: true });
    await setOwnerCompany(db(), "u1", "IE6388047V");

    const patch = h.updateMock.mock.calls[0]![0];
    for (const forbidden of ["tier", "verified_at", "kind", "subject", "failure_count", "published", "verification_token"]) {
      expect(patch).not.toHaveProperty(forbidden);
    }
  });

  it("records a company whose registration has lapsed, as lapsed", async () => {
    h.lookupCompanyMock.mockResolvedValue({ ok: true, name: "Dormant Co", jurisdiction: "GB", active: false });
    await setOwnerCompany(db(), "u1", "529900T8BM49AURSDO55");
    expect(h.updateMock.mock.calls[0]![0]).toMatchObject({
      company_source: "lei",
      company_active: false,
    });
  });

  it("refuses an identifier no free register can answer, without a lookup", async () => {
    const result = await setOwnerCompany(db(), "u1", "Acme Limited");
    expect(result).toMatchObject({ ok: false, status: 400, code: "invalid_company_id" });
    expect(h.lookupCompanyMock).not.toHaveBeenCalled();
    expect(h.updateMock).not.toHaveBeenCalled();
  });

  it("separates a register that would not answer from a company that is not in it", async () => {
    h.lookupCompanyMock.mockResolvedValue({ ok: false, reason: "unreachable" });
    await expect(setOwnerCompany(db(), "u1", "IE6388047V")).resolves.toMatchObject({
      code: "register_unreachable",
    });

    h.lookupCompanyMock.mockResolvedValue({ ok: false, reason: "not_found" });
    await expect(setOwnerCompany(db(), "u1", "IE6388047V")).resolves.toMatchObject({
      code: "company_not_found",
    });
    expect(h.updateMock).not.toHaveBeenCalled();
  });

  // A company line rides on a binding; it is not a binding of its own. Without
  // this, a tenant with no owner row would get one written by a lookup that
  // proves nothing, and `readOwner` would then report an owner whose kind and
  // subject were never declared.
  it("refuses when the tenant has declared no owner at all", async () => {
    selected = { data: null, error: null };
    await expect(setOwnerCompany(db(), "u1", "IE6388047V")).resolves.toMatchObject({
      status: 404,
      code: "no_owner",
    });
  });

  it("clears every company column together", async () => {
    await clearOwnerCompany(db(), "u1");
    expect(h.updateMock.mock.calls[0]![0]).toEqual({
      company_id: null,
      company_source: null,
      company_name: null,
      company_jurisdiction: null,
      company_active: null,
      company_checked_at: null,
    });
  });

  it("drops the cached owner after a company write", async () => {
    h.lookupCompanyMock.mockResolvedValue({ ok: true, name: "ACME", jurisdiction: "IE", active: true });
    await setOwnerCompany(db(), "u1", "IE6388047V");
    expect(h.purgeMock).toHaveBeenCalledWith("u1");
  });
});
