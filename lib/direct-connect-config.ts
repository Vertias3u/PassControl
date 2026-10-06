import { requestShapeFamily, type ProviderId } from "@/lib/providers";
import { servesResponsesOnly } from "@/lib/scope";
export { clientModelIsUsable as directClientModelIsUsable } from "@/lib/agent-connect";

export interface DirectConnectSetup {
  family: "openai" | "anthropic";
  label: "OpenAI-compatible SDK configuration" | "Anthropic SDK configuration";
  envBlock: string;
  example: string;
  smokeCommand: string;
  authNote: string;
  /** The variable the SDK reads its key from — the Direct Agent Key goes here. */
  keyVariable: "OPENAI_API_KEY" | "ANTHROPIC_API_KEY";
  installCommand: "npm install openai" | "npm install @anthropic-ai/sdk";
  envFileName: typeof ENV_FILE_NAME;
  /** POSIX shell; exports every variable in the file to the process started after it. */
  loadCommand: string;
  /**
   * One paste: writes `envBlock` to the env file, then runs `loadCommand`.
   * Pasting `envBlock` itself into a terminal sets variables an SDK never sees.
   */
  saveAndLoadCommand: string;
  runtimeNote: string;
}

/**
 * Stands in for the key when the Setup view is reopened after the reveal.
 * PassControl stores only a hash, so there is no key to show; the placeholder
 * is a bare token so the file still sources cleanly, and a call made with it
 * fails authentication loudly rather than doing anything else.
 */
export const DIRECT_KEY_PLACEHOLDER = "PASTE_YOUR_DIRECT_AGENT_KEY";
const ENV_FILE_NAME = "passcontrol.env";
const LOAD_COMMAND = `set -a; . ./${ENV_FILE_NAME}; set +a`;
// Quoted, so the shell writes the lines as they are and expands nothing. The
// load step still reads the file as shell, which is safe only because every
// value is a bare token: the origin, a pc_agent_ key or the placeholder, and a
// model that `clientModelIsUsable` limits to [A-Za-z0-9._:/-].
const HEREDOC_DELIMITER = "PASSCONTROL_ENV";

// chmod after the write, not umask before it: a umask only shapes a NEW file,
// and re-running the paste over a world-readable passcontrol.env must still
// leave the bearer key readable by its owner only.
function saveAndLoad(envBlock: string): string {
  return [
    `cat > ${ENV_FILE_NAME} <<'${HEREDOC_DELIMITER}'`,
    envBlock,
    HEREDOC_DELIMITER,
    `chmod 600 ${ENV_FILE_NAME}`,
    LOAD_COMMAND,
  ].join("\n");
}
const RUNTIME_NOTE =
  "In this worker's runtime, replace the provider key it used before with this Direct Agent Key. PassControl governs the model calls routed through it; it does not govern the worker process or any other API the worker calls.";

export interface HermesCloudSetup {
  version: "0.18.2";
  configPath: "~/.hermes/config.yaml";
  config: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Azure's own SDK class sends the credential as `api-key`, which the gateway does
 * not read an agent credential from, so an agent built on it is refused 401. The
 * plain OpenAI client pointed at the gateway is the supported shape.
 */
const AZURE_CLIENT_NOTE =
  " For Azure, use the plain OpenAI client shown here, not AzureOpenAI, and set the model to your Azure deployment name. PassControl sends the call to the resource address stored with your Azure key.";

export function buildDirectConnectSetup(input: {
  origin: string;
  provider: ProviderId;
  /** The newly revealed key, or null for a Setup view reopened later. */
  key: string | null;
  model: string;
}): DirectConnectSetup {
  const origin = input.origin.replace(/\/+$/, "");
  const family = requestShapeFamily(input.provider);
  const key = input.key ?? DIRECT_KEY_PLACEHOLDER;
  const shared = { envFileName: ENV_FILE_NAME, loadCommand: LOAD_COMMAND, runtimeNote: RUNTIME_NOTE } as const;
  if (family === "anthropic") {
    const envBlock = [
      `ANTHROPIC_BASE_URL=${origin}/api/v1/anthropic`,
      `ANTHROPIC_API_KEY=${key}`,
      `ANTHROPIC_MODEL=${input.model}`,
    ].join("\n");
    return {
      family,
      label: "Anthropic SDK configuration",
      envBlock,
      example: `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const response = await client.messages.create({
  model: process.env.ANTHROPIC_MODEL,
  max_tokens: 64,
  messages: [{ role: "user", content: "Hello" }],
});
console.log(response.content);`,
      smokeCommand: [
        `curl --fail-with-body ${shellQuote(`${origin}/api/v1/anthropic/v1/messages`)} \\`,
        `  -H "x-api-key: $ANTHROPIC_API_KEY" \\`,
        `  -H ${shellQuote("anthropic-version: 2023-06-01")} \\`,
        `  -H ${shellQuote("content-type: application/json")} \\`,
        `  --data ${shellQuote(JSON.stringify({
          model: input.model,
          max_tokens: 32,
          messages: [{ role: "user", content: "Reply with: PassControl connected" }],
        }))}`,
      ].join("\n"),
      authNote: "The Anthropic SDK sends this credential as x-api-key and uses the native Messages API. PassControl does not translate OpenAI request bodies into Anthropic request bodies.",
      keyVariable: "ANTHROPIC_API_KEY",
      installCommand: "npm install @anthropic-ai/sdk",
      saveAndLoadCommand: saveAndLoad(envBlock),
      ...shared,
    };
  }

  const envBlock = [
    `OPENAI_BASE_URL=${origin}/api/v1/${input.provider}/v1`,
    `OPENAI_API_KEY=${key}`,
    `OPENAI_MODEL=${input.model}`,
  ].join("\n");
  // A provider served only through Responses (xAI) refuses a chat call, so its
  // first example and smoke test must not be one.
  const responsesOnly = servesResponsesOnly(input.provider);
  return {
    family,
    label: "OpenAI-compatible SDK configuration",
    envBlock,
    example: responsesOnly
      ? `import OpenAI from "openai";

const client = new OpenAI();
const response = await client.responses.create({
  model: process.env.OPENAI_MODEL,
  input: "Hello",
  max_output_tokens: 256,
});
console.log(response.output_text);`
      : `import OpenAI from "openai";

const client = new OpenAI();
const response = await client.chat.completions.create({
  model: process.env.OPENAI_MODEL,
  messages: [{ role: "user", content: "Hello" }],
});
console.log(response.choices[0]?.message.content);`,
    smokeCommand: [
      `curl --fail-with-body ${shellQuote(`${origin}/api/v1/${input.provider}/v1/${responsesOnly ? "responses" : "chat/completions"}`)} \\`,
      `  -H "Authorization: Bearer $OPENAI_API_KEY" \\`,
      `  -H ${shellQuote("content-type: application/json")} \\`,
      `  --data ${shellQuote(JSON.stringify(
        responsesOnly
          ? { model: input.model, input: "Reply with: PassControl connected", max_output_tokens: 64 }
          : { model: input.model, messages: [{ role: "user", content: "Reply with: PassControl connected" }] }
      ))}`,
    ].join("\n"),
    authNote:
      "The OpenAI SDK sends this credential as Bearer authentication. Some compatible clients use x-api-key instead; PassControl accepts either, and Bearer wins when both are present." +
      (input.provider === "azure" ? AZURE_CLIENT_NOTE : ""),
    keyVariable: "OPENAI_API_KEY",
    installCommand: "npm install openai",
    saveAndLoadCommand: saveAndLoad(envBlock),
    ...shared,
  };
}

/** Hermes custom providers speak the OpenAI chat-completions shape. A native
 * Anthropic Messages credential is therefore intentionally not presented as a
 * working Hermes setup. */
export function buildHermesCloudSetup(input: {
  origin: string;
  provider: ProviderId;
  key: string;
  model: string;
}): HermesCloudSetup | null {
  if (requestShapeFamily(input.provider) !== "openai") return null;
  // Hermes speaks Chat Completions; a Responses-only provider would refuse it.
  if (servesResponsesOnly(input.provider)) return null;
  const origin = input.origin.replace(/\/+$/u, "");
  const yaml = (value: string) => JSON.stringify(value);
  return {
    version: "0.18.2",
    configPath: "~/.hermes/config.yaml",
    config: [
      "model:",
      `  default: ${yaml(input.model)}`,
      "  provider: custom",
      `  base_url: ${yaml(`${origin}/api/v1/${input.provider}/v1`)}`,
      `  api_key: ${yaml(input.key)}`,
    ].join("\n"),
  };
}
