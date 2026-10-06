// F1 / plans/tier3.md T3-1 — the verify pages must admit when nobody else can
// verify. A self-hosted instance defaults to PASSCONTROL_ISSUER=http://localhost:3000,
// which resolves for no one outside that machine; the page must not invite a
// belief in a verification path that does not exist. Nothing is disabled: local
// verification is real. The claim narrowed is WHO ELSE can check.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { issuerReach } from "@/lib/verify/issuer-reach";
import { IssuerReachNotice } from "@/components/IssuerReachNotice";

afterEach(() => vi.unstubAllEnvs());

describe("issuerReach", () => {
  it.each([
    ["https://passcontrol.vertias.eu", "public"],
    ["https://gateway.example.com", "public"],
    ["http://localhost:3000", "local"],
    ["http://127.0.0.1:3000", "local"],
    ["http://[::1]:3000", "local"],
    ["https://box.local", "local"],
    ["https://pc.localhost", "local"],
    ["https://10.1.2.3", "local"],
    ["https://172.16.0.9", "local"],
    ["https://172.31.255.1", "local"],
    ["https://192.168.1.20", "local"],
    ["https://169.254.10.10", "local"],
    ["https://[fd12::1]", "local"],
    ["https://[fe80::1]", "local"],
    ["https://172.32.0.1", "public"],
    ["", "unset"],
    [null, "unset"],
    ["not a url", "unset"],
  ] as const)("%s → %s", (issuer, reach) => {
    expect(issuerReach(issuer)).toBe(reach);
  });
});

describe("IssuerReachNotice", () => {
  it("warns on a loopback issuer, names it, and says local verification still works", () => {
    vi.stubEnv("PASSCONTROL_ISSUER", "http://localhost:3000");
    const html = renderToStaticMarkup(<IssuerReachNotice />);
    expect(html).toContain('data-issuer-reach="local"');
    expect(html).toContain("http://localhost:3000");
    expect(html).toMatch(/verify here/);
    expect(html).toMatch(/no one outside this machine/);
    expect(html).toContain("PASSCONTROL_ISSUER");
  });

  it("says an instance with no issuer signs nothing anyone can verify", () => {
    vi.stubEnv("PASSCONTROL_ISSUER", "");
    const html = renderToStaticMarkup(<IssuerReachNotice />);
    expect(html).toContain('data-issuer-reach="unset"');
    expect(html).toMatch(/does not sign receipts/);
  });

  it("renders nothing for a public https issuer", () => {
    vi.stubEnv("PASSCONTROL_ISSUER", "https://passcontrol.vertias.eu");
    expect(renderToStaticMarkup(<IssuerReachNotice />)).toBe("");
  });
});

describe("the verify pages carry the notice", () => {
  it.each(["app/verify/page.tsx", "app/verify/[passportId]/page.tsx", "app/verify/receipt/page.tsx"])(
    "%s renders IssuerReachNotice",
    async (file) => {
      const { readFileSync } = await import("node:fs");
      const src = readFileSync(file, "utf8");
      expect(src).toContain("<IssuerReachNotice");
    }
  );

  // What a self-hoster's /verify pages render (the REPLACE siblings privately,
  // the files themselves in the mirror).
  it.each(["app/verify/page.tsx", "app/verify/[passportId]/page.tsx", "app/verify/receipt/page.tsx"])(
    "Core's %s renders IssuerReachNotice",
    async (file) => {
      const { coreSource } = await import("./support/curated-source");
      expect(coreSource(file)).toContain("<IssuerReachNotice");
    }
  );
});
