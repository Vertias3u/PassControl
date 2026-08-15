import { requestShapeFamily, type ProviderId } from "@/lib/providers";
export { clientModelIsUsable as directClientModelIsUsable } from "@/lib/agent-connect";

export interface DirectConnectSetup {
  family: "openai" | "anthropic";
  label: "OpenAI-compatible SDK configuration" | "Anthropic SDK configuration";
  envBlock: string;
  example: string;
  smokeCommand: string;
  authNote: string;
}

export interface HermesCloudSetup {
  version: "0.18.2";
  configPath: "~/.hermes/config.yaml";
  config: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildDirectConnectSetup(input: {
  origin: string;
  provider: ProviderId;
  key: string;
  model: string;
}): DirectConnectSetup {
  const origin = input.origin.replace(/\/+$/, "");
  const family = requestShapeFamily(input.provider);
  if (family === "anthropic") {
    const envBlock = [
      `ANTHROPIC_BASE_URL=${origin}/api/v1/anthropic`,
      `ANTHROPIC_API_KEY=${input.key}`,
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
    };
  }

  const envBlock = [
    `OPENAI_BASE_URL=${origin}/api/v1/${input.provider}/v1`,
    `OPENAI_API_KEY=${input.key}`,
    `OPENAI_MODEL=${input.model}`,
  ].join("\n");
  return {
    family,
    label: "OpenAI-compatible SDK configuration",
    envBlock,
    example: `import OpenAI from "openai";

const client = new OpenAI();
const response = await client.chat.completions.create({
  model: process.env.OPENAI_MODEL,
  messages: [{ role: "user", content: "Hello" }],
});
console.log(response.choices[0]?.message.content);`,
    smokeCommand: [
      `curl --fail-with-body ${shellQuote(`${origin}/api/v1/${input.provider}/v1/chat/completions`)} \\`,
      `  -H "Authorization: Bearer $OPENAI_API_KEY" \\`,
      `  -H ${shellQuote("content-type: application/json")} \\`,
      `  --data ${shellQuote(JSON.stringify({
        model: input.model,
        messages: [{ role: "user", content: "Reply with: PassControl connected" }],
      }))}`,
    ].join("\n"),
    authNote: "The OpenAI SDK sends this credential as Bearer authentication. Some compatible clients use x-api-key instead; PassControl accepts either, and Bearer wins when both are present.",
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
