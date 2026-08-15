#!/usr/bin/env node

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function concreteAddress(value) {
  if (!present(value)) return false;
  const address = value.trim();
  if (/pending|tbd|to be confirmed|your[-_ ]address|replace[-_ ]me/i.test(address)) return false;
  // "Sofia, Bulgaria" is a location, not the geographic service address the
  // legal notice promises. A street/office address will contain a premise or
  // postal number and enough context to be directly usable.
  return address.length >= 20 && /\d/u.test(address) && /(?:bulgaria|\bBG\b)/iu.test(address);
}

function isoDate(value) {
  if (!present(value) || !/^\d{4}-\d{2}-\d{2}$/u.test(value.trim())) return false;
  const parsed = new Date(`${value.trim()}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(value.trim());
}

export function checkLegalReadiness(env, { requireServiceAddress = false } = {}) {
  const problems = [];
  if (requireServiceAddress && !concreteAddress(env.PASSCONTROL_PUBLIC_SERVICE_ADDRESS)) {
    problems.push(
      "PASSCONTROL_PUBLIC_SERVICE_ADDRESS: must be a concrete public geographic service address in Bulgaria, not a city or placeholder"
    );
  }
  if (!isoDate(env.PASSCONTROL_LEGAL_EFFECTIVE_DATE)) {
    problems.push("PASSCONTROL_LEGAL_EFFECTIVE_DATE: must be a real ISO date (YYYY-MM-DD)");
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const paidCommercialLaunch = process.argv.slice(2).includes("--paid-commercial-launch");
  const problems = checkLegalReadiness(process.env, {
    requireServiceAddress: paidCommercialLaunch,
  });
  if (problems.length) {
    console.error(problems.map((problem) => `✗ ${problem}`).join("\n"));
    process.exit(1);
  }
  console.log(
    paidCommercialLaunch
      ? "✓ paid-launch legal identity, service address and effective date are configured"
      : "✓ free-beta legal identity and effective date are configured"
  );
}
