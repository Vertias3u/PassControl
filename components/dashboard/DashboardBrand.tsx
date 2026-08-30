// The one lockup the Control Tower renders — sidebar, mobile bar, loading skeleton
// and the Control Graph's presentation mode.
//
// It exists because four call sites used to inline the lockup, which meant four places
// to keep in step. The mark and wordmark themselves come from components/SiteBrand.tsx,
// which is where the two trees actually differ; what is left here is layout.
//
// Everything outside that region — the element order, the class hooks the shell's CSS
// selects on, the sizes — is identical in both, so the hosted UI is byte-equivalent to
// what the four call sites rendered before.
import { SiteLogo, SiteWordmark } from "@/components/SiteBrand";

export function DashboardBrand({
  markSize,
  wordmarkSize,
  detail,
  layout = "stacked",
}: {
  markSize: number;
  wordmarkSize: number;
  /** Text after the product name — "Control Graph". Omitted on the plain shells. */
  detail?: string;
  /** "inline" is the mobile bar, where the product name sits beside the wordmark. */
  layout?: "stacked" | "inline";
}) {
  const mark = <SiteLogo size={markSize} />;
  const wordmark = <SiteWordmark size={wordmarkSize} />;
  // The one thing the shared mark cannot settle: what the line under the wordmark says.
  const productLine: string | null = detail ?? null;

  if (layout === "inline") {
    return (
      <>
        {mark}
        {wordmark}
        {/* One text child, not two: React's SSR separates adjacent text nodes. */}
        {productLine ? <span>{`/ ${productLine}`}</span> : null}
      </>
    );
  }

  return (
    <>
      {mark}
      <span>
        {wordmark}
        {productLine ? <small>{productLine}</small> : null}
      </span>
    </>
  );
}
