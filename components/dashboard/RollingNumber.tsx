"use client";

import { useEffect, useRef, useState } from "react";
import { animateNumber } from "@/lib/motion";

/** Start at the real value; only subsequent updates roll, never the first paint. */
export function RollingNumber({ value, format = "integer" }: { value: number; format?: "integer" | "dollars" }) {
  const root = useRef<HTMLSpanElement>(null);
  const current = useRef(value);
  const [displayed, setDisplayed] = useState(value);
  useEffect(() => animateNumber(current.current, value, (next) => {
    current.current = next;
    setDisplayed(next);
  }, root.current), [value]);
  const text = (number: number) => format === "dollars" ? `$${number.toFixed(2)}` : String(Math.round(number));
  return (
    <span ref={root} className="tabular-nums">
      <span className="sr-only">{text(value)}</span>
      <span aria-hidden="true" data-rolling-value="true">{text(displayed)}</span>
    </span>
  );
}
