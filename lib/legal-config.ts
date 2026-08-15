const address = process.env.PASSCONTROL_PUBLIC_SERVICE_ADDRESS?.trim() ?? "";
const effectiveDate = process.env.PASSCONTROL_LEGAL_EFFECTIVE_DATE?.trim() ?? "";

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

export const PUBLIC_SERVICE_ADDRESS = address || null;
export const LEGAL_EFFECTIVE_DATE = validIsoDate(effectiveDate) ? effectiveDate : null;
// The free invite beta is operated truthfully by a named individual. A public
// service address remains an explicit paid-commercial-launch gate, but absence
// of one must not turn an otherwise effective free-beta notice back into a
// draft or encourage the operator to publish a private home address.
export const LEGAL_IS_DRAFT = !LEGAL_EFFECTIVE_DATE;

export function legalDateLabel(): string {
  if (!LEGAL_EFFECTIVE_DATE) return "Not yet effective";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${LEGAL_EFFECTIVE_DATE}T00:00:00.000Z`));
}
