"use client";

import { useEffect, useState } from "react";

/** A fixed clock sample after hydration; both first renders see null. */
export function useHydratedNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => { setNow(Date.now()); }, []);
  return now;
}
