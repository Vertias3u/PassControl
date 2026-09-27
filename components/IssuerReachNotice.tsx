// The verify pages' admission of reach (plans/tier3.md T3-1). Server-rendered
// from this instance's own issuer: renders NOTHING when the issuer is a public
// https origin, and says plainly who can and cannot check receipts otherwise.
// Asserted on `data-issuer-reach`, not on prose.
import { instanceIssuer } from "@/lib/crypto/instanceKey";
import { issuerReach } from "@/lib/verify/issuer-reach";

export function IssuerReachNotice() {
  const issuer = instanceIssuer();
  const reach = issuerReach(issuer);
  if (reach === "public") return null;
  return (
    <aside
      className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm leading-6 text-foreground"
      data-issuer-reach={reach}
      role="note"
    >
      {reach === "local" ? (
        <p className="m-0">
          This instance&rsquo;s issuer is <code className="break-all">{issuer}</code>. Receipts it signs verify
          here, but no one outside this machine can fetch its keys to check them. Set{" "}
          <code>PASSCONTROL_ISSUER</code> to a public https origin to make them externally verifiable.
        </p>
      ) : (
        <p className="m-0">
          This instance does not sign receipts: <code>PASSCONTROL_ISSUER</code> is not set to a usable origin.
          Receipts from other issuers can still be checked here.
        </p>
      )}
    </aside>
  );
}
