import { requestShapeFamily, type ProviderId } from "@/lib/providers";

export type PassportIntegration = "openai-js" | "anthropic-js";

export interface PassportConnectSetup {
  integration: PassportIntegration;
  integrationLabel: "OpenAI JavaScript SDK" | "Anthropic JavaScript SDK";
  installCommand: string;
  envBlock: string;
  clientFilename: "passcontrol-client.mjs";
  clientCode: string;
  smokeFilename: "passcontrol-smoke.mjs";
  smokeCode: string;
  smokeCommand: "node passcontrol-smoke.mjs";
}

function shellQuote(value: string): string {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function passportIntegrationForProvider(provider: ProviderId): PassportIntegration {
  return requestShapeFamily(provider) === "anthropic" ? "anthropic-js" : "openai-js";
}

/** Build reveal-once Cloud setup text. Only envBlock contains the private key;
 * source examples reference environment variables and are safe to retain. */
export function buildPassportConnectSetup(input: {
  origin: string;
  provider: ProviderId;
  passportId: string;
  passportSecret: string;
  model: string;
}): PassportConnectSetup {
  const origin = input.origin.replace(/\/+$/u, "");
  const envBlock = [
    `export PASSCONTROL_GATEWAY=${shellQuote(origin)}`,
    `export PASSPORT_ID=${shellQuote(input.passportId)}`,
    `export PASSPORT_SECRET=${shellQuote(input.passportSecret)}`,
    `export PASSCONTROL_MODEL=${shellQuote(input.model)}`,
  ].join("\n");

  if (passportIntegrationForProvider(input.provider) === "anthropic-js") {
    return {
      integration: "anthropic-js",
      integrationLabel: "Anthropic JavaScript SDK",
      installCommand: "npm install passcontrol@^0.6.0 @anthropic-ai/sdk",
      envBlock,
      clientFilename: "passcontrol-client.mjs",
      clientCode: `import Anthropic from "@anthropic-ai/sdk";
import { PassControl } from "passcontrol/sdk";

const passcontrol = new PassControl({
  gateway: process.env.PASSCONTROL_GATEWAY,
  passportId: process.env.PASSPORT_ID,
  passportSecret: process.env.PASSPORT_SECRET,
});

export const client = new Anthropic(passcontrol.clientOptions("anthropic"));`,
      smokeFilename: "passcontrol-smoke.mjs",
      smokeCode: `import { client } from "./passcontrol-client.mjs";

const response = await client.messages.create({
  model: process.env.PASSCONTROL_MODEL,
  max_tokens: 32,
  messages: [{ role: "user", content: "Reply with: PassControl connected" }],
});

console.log(response.content);`,
      smokeCommand: "node passcontrol-smoke.mjs",
    };
  }

  return {
    integration: "openai-js",
    integrationLabel: "OpenAI JavaScript SDK",
    installCommand: "npm install passcontrol@^0.6.0 openai",
    envBlock,
    clientFilename: "passcontrol-client.mjs",
    clientCode: `import OpenAI from "openai";
import { PassControl } from "passcontrol/sdk";

const passcontrol = new PassControl({
  gateway: process.env.PASSCONTROL_GATEWAY,
  passportId: process.env.PASSPORT_ID,
  passportSecret: process.env.PASSPORT_SECRET,
});

export const client = new OpenAI(passcontrol.clientOptions(${JSON.stringify(input.provider)}));`,
    smokeFilename: "passcontrol-smoke.mjs",
    smokeCode: `import { client } from "./passcontrol-client.mjs";

const response = await client.chat.completions.create({
  model: process.env.PASSCONTROL_MODEL,
  messages: [{ role: "user", content: "Reply with: PassControl connected" }],
});

console.log(response.choices[0]?.message.content);`,
    smokeCommand: "node passcontrol-smoke.mjs",
  };
}
