// Who else can check a receipt this issuer signed (plans/tier3.md T3-1).
//
// Verification fetches `<issuer>/.well-known/jwks.json`. An issuer on a
// loopback, link-local, private-range or `.local` host is reachable from its
// own machine or network only: receipts it signs verify there, and nowhere
// else. That is still real verification — it proves the record was not
// altered — so nothing is disabled; the claim that narrows is who else can
// check it. `unset` means the instance has no usable issuer and signs no
// receipts at all (lib/receipt.ts refuses to sign without one).
export type IssuerReach = "public" | "local" | "unset";

function privateIPv4(host: string): boolean {
  const parts = host.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0
  );
}

function privateIPv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h.includes(":")) return false;
  return h === "::1" || h === "::" || /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h);
}

export function issuerReach(issuer: string | null | undefined): IssuerReach {
  if (!issuer) return "unset";
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return "unset";
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    privateIPv4(host) ||
    privateIPv6(host)
  ) {
    return "local";
  }
  return "public";
}
