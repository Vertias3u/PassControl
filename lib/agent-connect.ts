import type { ProviderId } from "@/lib/providers";
import {
  DEFAULT_ALLOWED_MODELS as SHARED_ALLOWED_MODELS,
  DEFAULT_CLIENT_MODELS as SHARED_CLIENT_MODELS,
} from "@/cli/integration-defaults.mjs";

/** One source for the capability pattern and the concrete model shown by both
 * Direct Agent Key and Passport onboarding. The two values are deliberately
 * separate: the first authorizes; the second is sent to the provider. */
export const DEFAULT_ALLOWED_MODELS: Readonly<Record<ProviderId, string>> = SHARED_ALLOWED_MODELS;

export const DEFAULT_CLIENT_MODELS: Readonly<Record<ProviderId, string>> = SHARED_CLIENT_MODELS;

/** Runtime model ids are copied into environment/configuration blocks and sent
 * verbatim to a provider. Wildcards belong only in the capability pattern. */
export function clientModelIsUsable(value: string): boolean {
  const model = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(model);
}
