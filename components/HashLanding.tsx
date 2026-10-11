"use client";

// Lands an in-page jump that arrived by client navigation, once the page's real
// sections exist (lib/hash-landing.ts says why Next alone does not). Mounted by
// the pages whose route has a loading.tsx and in-page anchors.
import { useEffect } from "react";
import { holdHashTarget, type HashLandingWindow } from "@/lib/hash-landing";

export function HashLanding() {
  useEffect(() => holdHashTarget(window as unknown as HashLandingWindow), []);
  return null;
}
