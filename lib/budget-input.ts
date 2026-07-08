function cleaned(raw: string): string {
  return raw.trim();
}

export function parseTokenBudgetInput(raw: string): number | null {
  const v = cleaned(raw);
  if (!v) return null;
  if (!/^\d+$/.test(v)) {
    throw new Error("Token budget must be a non-negative whole number.");
  }
  const n = Number(v);
  if (!Number.isSafeInteger(n)) {
    throw new Error("Token budget is too large.");
  }
  return n;
}

export function parseUsdBudgetToCents(raw: string): number | null {
  const v = cleaned(raw);
  if (!v) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(v)) {
    throw new Error("Cost budget (USD) must be a non-negative dollar amount with up to 2 decimals.");
  }
  const [dollarsRaw, centsRaw] = v.split(".");
  const dollars = dollarsRaw ?? "0";
  const cents = centsRaw ?? "";
  const total = BigInt(dollars) * 100n + BigInt(cents.padEnd(2, "0"));
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Cost budget is too large.");
  }
  return Number(total);
}

export function formatCentsAsUsdInput(cents: number | null): string {
  return cents == null ? "" : (cents / 100).toFixed(2);
}

export function formatCentsAsUsdDisplay(cents: number | null): string {
  return cents == null ? "∞" : `$${(cents / 100).toFixed(2)}`;
}
