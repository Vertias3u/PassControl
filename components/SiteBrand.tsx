// The mark and wordmark every chrome in the app renders — dashboard, auth, verifier,
// profile, updates, 404, legal. Eleven call sites import these two components and
// nothing else, so the whole visual identity of a deployment is settled here.
//
import { ShieldCheck } from "lucide-react";

// The eyebrow rendered beside the mark on the verifier, profile and 404 chromes.
export const SITE_BRAND_LABEL = "PassControl";


// The Core mark: the product's own shield, the same one the self-host landing page
// leads with. No company mark, because a self-hosted instance belongs to whoever runs it.
export function SiteLogo({ size = 44 }: { size?: number }) {
  return <ShieldCheck size={size} aria-hidden="true" />;
}

export function SiteWordmark({ size = 20 }: { size?: number }) {
  return (
    <span style={{ fontWeight: 800, fontSize: size, letterSpacing: "-0.02em" }}>
      PassControl
    </span>
  );
}
