"use client";
// Whether this deployment can reach a `local` provider, for the choosers that
// list providers. Set once by the dashboard shell from the operator gate
// (lib/providers/endpoint.ts), and FALSE by default: a chooser rendered outside
// the shell, as in a test, behaves as hosted Cloud does and does not offer it.
import { createContext, useContext, type ReactNode } from "react";

import { offeredProviders } from "@/lib/providers";

const LocalModelsContext = createContext(false);

export function LocalModelsProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return <LocalModelsContext.Provider value={enabled}>{children}</LocalModelsContext.Provider>;
}

export function useLocalModelsEnabled(): boolean {
  return useContext(LocalModelsContext);
}

/** `offeredProviders` with this deployment's gate. `keep` names values already saved. */
export function useOfferedProviders<T extends string>(
  list: readonly T[],
  ...keep: (string | null | undefined)[]
): T[] {
  return offeredProviders(list, useLocalModelsEnabled(), keep);
}
