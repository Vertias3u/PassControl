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
  return [
    `export PASSPORT_ID=${shellQuote(input.passportId)}`,
    `export PASSPORT_SECRET=${shellQuote(input.passportSecret)}`,
    `passcontrol configure ${input.integration} --provider ${input.provider} --model ${shellQuote(input.model)}`,
  ].join("\n");
}
