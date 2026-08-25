import { BadgeCheck } from "lucide-react";

/**
 * A compact social-style profile check.
 *
 * The icon is intentionally quieter than the owner-evidence pill below it:
 * this says the instance manually approved the account, while domain/IDV
 * evidence says what the operator actually proved. Those are separate claims.
 */
export function VerifiedProfileBadge({ verified }: { verified: boolean }) {
  if (!verified) return null;

  return (
    <span
      className="inline-flex shrink-0 items-center text-sky-500"
      data-profile-verified="true"
      aria-label="Verified profile"
      title="Verified by this PassControl instance"
    >
      <BadgeCheck className="h-[1.15em] w-[1.15em]" aria-hidden="true" />
    </span>
  );
}
