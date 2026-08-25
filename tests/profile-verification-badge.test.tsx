import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { VerifiedProfileBadge } from "@/components/VerifiedProfileBadge";

describe("the manual profile check", () => {
  it("renders a compact social-style check with an honest accessible label", () => {
    const html = renderToStaticMarkup(<VerifiedProfileBadge verified />);
    expect(html).toContain('data-profile-verified="true"');
    expect(html).toContain('aria-label="Verified profile"');
    expect(html).toContain("Verified by this PassControl instance");
  });

  it("renders nothing for an ordinary profile", () => {
    expect(renderToStaticMarkup(<VerifiedProfileBadge verified={false} />)).toBe("");
  });
});
