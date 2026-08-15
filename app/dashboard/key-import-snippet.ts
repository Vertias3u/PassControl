interface ConfigureSnippetInput {
  passportId: string;
  passportSecret: string;
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
 */
export function buildConfigureSnippet(input: ConfigureSnippetInput): string {
  if (!input.allowedIntegrations.includes(input.integration)) {
    throw new Error("Unknown integration preset.");
  }
  if (!isProvider(input.provider) || !clientModelIsUsable(input.model)) {
    throw new Error("Sidecar setup requires a supported provider and a concrete model id.");
  }
  return [
    `export PASSPORT_ID=${shellQuote(input.passportId)}`,
    `export PASSPORT_SECRET=${shellQuote(input.passportSecret)}`,
    `passcontrol configure ${input.integration} --provider ${input.provider} --model ${shellQuote(input.model)}`,
  ].join("\n");
}
import { clientModelIsUsable } from "@/lib/agent-connect";
import { isProvider } from "@/lib/providers";
