interface ConfigureSnippetInput {
  gateway: string;
  passportId: string;
  provider: string;
  model: string;
  integration: string;
  allowedIntegrations: readonly string[];
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Produce a pasteable handoff without duplicating any integration-specific
 * settings. The final command delegates those settings to the shipped CLI's
 * existing `configure` preset implementation.
 *
 * This deliberately does NOT begin with `passcontrol passport import`. The UI
 * gives that command its own step, because importing a private key is its own
 * security decision and reads as one. Repeating it here made the onboarding
 * flow hand the operator the same command twice, and the second run is refused:
 * `passport import` will not replace a configured passport without --replace.
 * The lines are newline-separated rather than `&&`-joined, so the refusal did
 * not stop the rest — it just put a failure in the middle of a flow that then
 * carried on, which is worse than either outcome on its own.
 */
export function buildConfigureSnippet(input: ConfigureSnippetInput): string {
  if (!input.allowedIntegrations.includes(input.integration)) {
    throw new Error("Unknown integration preset.");
  }
  if (!isProvider(input.provider) || !clientModelIsUsable(input.model)) {
    throw new Error("Sidecar setup requires a supported provider and a concrete model id.");
  }
  return [
    `passcontrol configure ${input.integration} --provider ${input.provider} --model ${shellQuote(input.model)}`,
    "passcontrol sidecar",
  ].join("\n");
}

export function buildPassportImportCommand(input: { gateway: string; passportId: string }): string {
  const origin = new URL(input.gateway).origin;
  return `passcontrol passport import --global --gateway ${shellQuote(origin)} --id ${shellQuote(input.passportId)}`;
}
import { clientModelIsUsable } from "@/lib/agent-connect";
import { isProvider } from "@/lib/providers";
