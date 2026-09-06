import { describe, it, expect, vi } from "vitest";

import { classifyCompanyId, lookupCompany } from "@/lib/owner/company";

function json(body: unknown, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as unknown as Response;
}

describe("recognising which register an identifier belongs to", () => {
  // Both shapes are unambiguous, so the owner types one field and we work out
  // which register to ask. A second "which register?" dropdown would be a
  // question the string already answers.
  it("recognises a Legal Entity Identifier by shape and check digits", () => {
    expect(classifyCompanyId("5493001KJTIIGC8Y1R12")).toEqual({
      source: "lei",
      id: "5493001KJTIIGC8Y1R12",
    });
    expect(classifyCompanyId(" 529900t8bm49aursdo55 ")).toEqual({
      source: "lei",
      id: "529900T8BM49AURSDO55",
    });
  });

  // ISO 17442 carries ISO 7064 MOD 97-10 check digits. Verifying them locally
  // costs nothing and turns a typo into an error message instead of a lookup
  // that comes back "no such entity" and reads like the register is wrong.
  it("refuses an LEI whose check digits do not hold", () => {
    expect(classifyCompanyId("5493001KJTIIGC8Y1R13")).toBeNull();
  });

  it("recognises an EU VAT number, including the two codes that are not ISO", () => {
    expect(classifyCompanyId("IE6388047V")).toEqual({ source: "vat", id: "IE6388047V" });
    expect(classifyCompanyId("bg123456789")).toEqual({ source: "vat", id: "BG123456789" });
    // VIES calls Greece EL, not GR, and covers Northern Ireland as XI.
    expect(classifyCompanyId("EL123456789")).toEqual({ source: "vat", id: "EL123456789" });
    expect(classifyCompanyId("XI123456789")).toEqual({ source: "vat", id: "XI123456789" });
  });

  it("accepts the punctuation people actually paste", () => {
    expect(classifyCompanyId("IE 6388047 V")).toEqual({ source: "vat", id: "IE6388047V" });
    expect(classifyCompanyId("BG-123456789")).toEqual({ source: "vat", id: "BG123456789" });
  });

  it.each([
    ["a country code that is not in VIES", "GR123456789"],
    ["a US EIN", "12-3456789"],
    ["a free-text company name", "Acme Limited"],
    ["something URL-shaped", "https://acme.com"],
    ["a path traversal", "../../etc/passwd"],
    ["empty", ""],
    ["far too long", "X".repeat(64)],
  ])("refuses %s", (_label, value) => {
    expect(classifyCompanyId(value)).toBeNull();
  });

  it("refuses anything that is not a string", () => {
    expect(classifyCompanyId(null)).toBeNull();
    expect(classifyCompanyId(12345)).toBeNull();
  });
});

describe("looking a company up in its register", () => {
  it("resolves a VAT number to its registered name", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({
        isValid: true,
        name: "GOOGLE IRELAND LIMITED",
        address: "3RD FLOOR, GORDON HOUSE, BARROW STREET, DUBLIN 4",
      })
    );
    await expect(lookupCompany("IE6388047V", "vat", { fetch: fetchImpl })).resolves.toEqual({
      ok: true,
      name: "GOOGLE IRELAND LIMITED",
      jurisdiction: "IE",
      active: true,
    });
  });

  // The register returns a postal address. We do not want it, do not store it,
  // and must not leak it into a record that gets published on /verify.
  it("never carries the address the register returns", async () => {
    const address = "3RD FLOOR, GORDON HOUSE, BARROW STREET, DUBLIN 4";
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(json({ isValid: true, name: "GOOGLE IRELAND LIMITED", address }));
    const result = await lookupCompany("IE6388047V", "vat", { fetch: fetchImpl });
    expect(JSON.stringify(result)).not.toContain("GORDON HOUSE");
  });

  // Several member states validate a number without returning a name. That is a
  // real answer, not a failure, and it must not become an empty-string name.
  it("keeps a nameless but valid VAT answer as valid with no name", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ isValid: true, name: "---", address: "---" }));
    await expect(lookupCompany("DE123456789", "vat", { fetch: fetchImpl })).resolves.toEqual({
      ok: true,
      name: null,
      jurisdiction: "DE",
      active: true,
    });
  });

  it("reports an invalid VAT number as not found", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ isValid: false, userError: "INVALID" }));
    await expect(lookupCompany("IE9999999X", "vat", { fetch: fetchImpl })).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("resolves an LEI to its legal name, jurisdiction and status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({
        data: {
          attributes: {
            lei: "5493001KJTIIGC8Y1R12",
            entity: {
              legalName: { name: "Bloomberg Finance L.P." },
              status: "ACTIVE",
              jurisdiction: "US-DE",
            },
            registration: { status: "ISSUED" },
          },
        },
      })
    );
    await expect(
      lookupCompany("5493001KJTIIGC8Y1R12", "lei", { fetch: fetchImpl })
    ).resolves.toEqual({
      ok: true,
      name: "Bloomberg Finance L.P.",
      jurisdiction: "US-DE",
      active: true,
    });
  });

  // A lapsed registration is exactly the fact a reader of /verify wants, so it
  // comes back as a successful lookup that is not active — not as an error that
  // would render identically to "we could not reach the register".
  it("returns a lapsed registration as found but not active", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({
        data: {
          attributes: {
            entity: { legalName: { name: "Dormant Co" }, status: "ACTIVE", jurisdiction: "GB" },
            registration: { status: "LAPSED" },
          },
        },
      })
    );
    await expect(
      lookupCompany("529900T8BM49AURSDO55", "lei", { fetch: fetchImpl })
    ).resolves.toMatchObject({ ok: true, active: false });
  });

  it("reports an unknown LEI as not found", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ errors: [] }, { status: 404 }));
    await expect(
      lookupCompany("529900T8BM49AURSDO55", "lei", { fetch: fetchImpl })
    ).resolves.toEqual({ ok: false, reason: "not_found" });
  });

  it("separates a register that would not answer from a company that is not in it", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network"));
    await expect(lookupCompany("IE6388047V", "vat", { fetch: fetchImpl })).resolves.toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  it("treats an unparseable answer as unreachable rather than as a verdict", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "<html>maintenance</html>",
      headers: new Headers(),
    } as unknown as Response);
    await expect(lookupCompany("IE6388047V", "vat", { fetch: fetchImpl })).resolves.toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  it("refuses an identifier that does not classify, without making a request", async () => {
    const fetchImpl = vi.fn();
    await expect(lookupCompany("Acme Limited", "vat", { fetch: fetchImpl })).resolves.toEqual({
      ok: false,
      reason: "invalid_id",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an identifier whose shape does not match the register asked for", async () => {
    const fetchImpl = vi.fn();
    // A valid LEI, asked of VIES. Interpolating it into the VAT URL would send a
    // request no register can answer, on a path built from the wrong shape.
    await expect(
      lookupCompany("5493001KJTIIGC8Y1R12", "vat", { fetch: fetchImpl })
    ).resolves.toEqual({ ok: false, reason: "invalid_id" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never follows a redirect and always bounds the read", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ isValid: true, name: "ACME", address: "-" }));
    await lookupCompany("IE6388047V", "vat", { fetch: fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain("/IE/vat/6388047V");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
