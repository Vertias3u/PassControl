// The operator's website link.
//
// This is the one genuinely new injection surface the profile feature adds: an
// operator-controlled string that gets rendered as an `href` on a page a
// stranger reads. 0033 puts a `^https?://` CHECK behind it as a backstop, but
// the constraint cannot see the two attacks that survive a scheme check —
// credentials in the authority (`https://vertias.eu@evil.example`, which
// DISPLAYS as vertias.eu and navigates to evil.example) and a protocol-relative
// `//evil.example` — so those are this module's job.
import { describe, expect, it } from "vitest";

import { WEBSITE_URL_MAX_LENGTH, normalizeWebsiteUrl } from "@/lib/profile/url";

function ok(value: unknown): string | null {
  const result = normalizeWebsiteUrl(value);
  expect(result.ok, `expected ${String(value)} to be accepted`).toBe(true);
  return result.ok ? result.url : null;
}

function rejected(value: unknown): void {
  expect(normalizeWebsiteUrl(value), `expected ${String(value)} to be rejected`).toEqual({
    ok: false,
    reason: "invalid_url",
  });
}

describe("clearing the field", () => {
  it("treats blank and non-string input as no link at all", () => {
    for (const value of ["", "   ", null, undefined, 42, {}]) {
      expect(normalizeWebsiteUrl(value)).toEqual({ ok: true, url: null });
    }
  });
});

describe("accepting a real link", () => {
  it("keeps https as given", () => {
    expect(ok("https://vertias.eu/about")).toBe("https://vertias.eu/about");
  });

  // Typing a bare domain is what people actually do. Assuming https rather than
  // http means the friendly path is also the safe one.
  it("assumes https for a bare domain", () => {
    expect(ok("vertias.eu")).toBe("https://vertias.eu/");
    expect(ok("  VERTIAS.eu/Path  ")).toBe("https://vertias.eu/Path");
  });

  it("allows http, because plenty of small sites are still http", () => {
    expect(ok("http://example.com/")).toBe("http://example.com/");
  });

  it("preserves the path case while folding the host", () => {
    expect(ok("https://Example.com/CaseSensitive")).toBe("https://example.com/CaseSensitive");
  });
});

describe("refusing a hostile link", () => {
  // The classic. 0033's CHECK also refuses these, deliberately — the point is
  // that a bypass here is still unstorable.
  it("refuses script-bearing and data schemes", () => {
    for (const value of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "  javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://vertias.eu/abc",
    ]) {
      rejected(value);
    }
  });

  // Whitespace and control characters are how a scheme gets smuggled past a
  // naive prefix test: browsers strip them before parsing, validators do not.
  it("refuses a scheme obscured by control characters", () => {
    rejected("java\nscript:alert(1)");
    rejected("java\tscript:alert(1)");
    rejected("java\0script:alert(1)");
  });

  // Displays as vertias.eu, navigates to evil.example. The CHECK constraint in
  // 0033 cannot catch this one — it starts with https://.
  it("refuses credentials in the authority, which disguise the real host", () => {
    rejected("https://vertias.eu@evil.example/");
    rejected("https://user:pass@evil.example/");
  });

  it("refuses a protocol-relative link", () => {
    rejected("//evil.example/path");
  });

  it("refuses anything without a real hostname", () => {
    for (const value of ["https://", "https://localhost", "notadomain", "https://a b.com"]) {
      rejected(value);
    }
  });

  it("refuses a link longer than the column allows", () => {
    const long = `https://vertias.eu/${"a".repeat(WEBSITE_URL_MAX_LENGTH)}`;
    expect(long.length).toBeGreaterThan(WEBSITE_URL_MAX_LENGTH);
    rejected(long);
  });
});

describe("agreement with the database", () => {
  // Whatever this function returns has to satisfy 0033's users_website_url_scheme
  // and users_website_url_len, or an accepted link fails at the write with an
  // unmapped 23514.
  it("only ever returns something the CHECK constraints accept", () => {
    for (const value of ["vertias.eu", "https://vertias.eu/about", "http://example.com"]) {
      const url = ok(value)!;
      expect(url).toMatch(/^https?:\/\//);
      expect(url.length).toBeLessThanOrEqual(WEBSITE_URL_MAX_LENGTH);
    }
  });
});
