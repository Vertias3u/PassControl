import { requestShapeFamily, type ProviderId } from "@/lib/providers";
import { servesResponsesOnly } from "@/lib/scope";
import { RELEASE_VERSION } from "@/lib/version";

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
      installCommand: `npm install passcontrol@^${RELEASE_VERSION} @anthropic-ai/sdk`,
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
    installCommand: `npm install passcontrol@^${RELEASE_VERSION} openai`,
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
    // A Responses-only provider (xAI) refuses a chat call.
    smokeCode: servesResponsesOnly(input.provider)
      ? `import { client } from "./passcontrol-client.mjs";

const response = await client.responses.create({
  model: process.env.PASSCONTROL_MODEL,
  input: "Reply with: PassControl connected",
  max_output_tokens: 64,
});

console.log(response.output_text);`
      : `import { client } from "./passcontrol-client.mjs";

const response = await client.chat.completions.create({
  model: process.env.PASSCONTROL_MODEL,
  messages: [{ role: "user", content: "Reply with: PassControl connected" }],
});

console.log(response.choices[0]?.message.content);`,
    smokeCommand: "node passcontrol-smoke.mjs",
  };
}

export interface PassportServiceSetup {
  installCommand: string;
  envBlock: string;
  clientFilename: "passcontrol-services.mjs";
  clientCode: string;
  sidecarCommands: string;
}

/**
 * Setup for a passport agent that calls services (GitHub, Telegram) and no
 * model. The SDK's `fetch` mints and refreshes the visa on every call, so
 * Octokit takes it as its transport and no token is configured at all. Proven
 * with real Octokit through pc.fetch, pagination included, 2026-10-02. Only
 * envBlock contains the private key.
 */
export function buildPassportServiceSetup(input: {
  origin: string;
  passportId: string;
  passportSecret: string;
}): PassportServiceSetup {
  const origin = input.origin.replace(/\/+$/u, "");
  return {
    installCommand: `npm install passcontrol@^${RELEASE_VERSION} octokit`,
    envBlock: [
      `export PASSCONTROL_GATEWAY=${shellQuote(origin)}`,
      `export PASSPORT_ID=${shellQuote(input.passportId)}`,
      `export PASSPORT_SECRET=${shellQuote(input.passportSecret)}`,
    ].join("\n"),
    clientFilename: "passcontrol-services.mjs",
    clientCode: `import { Octokit } from "octokit";
import { PassControl } from "passcontrol/sdk";

const passcontrol = new PassControl({
  gateway: process.env.PASSCONTROL_GATEWAY,
  passportId: process.env.PASSPORT_ID,
  passportSecret: process.env.PASSPORT_SECRET,
});

// GitHub: PassControl adds a fresh visa to every request; the GitHub token stays in PassControl.
export const github = new Octokit({
  baseUrl: \`\${process.env.PASSCONTROL_GATEWAY}/api/v1/svc/github\`,
  request: { fetch: passcontrol.fetch },
});

// Telegram: call a Bot API method by name; the bot token stays in PassControl.
export const telegram = (method, body) =>
  passcontrol.fetch(\`\${process.env.PASSCONTROL_GATEWAY}/api/v1/svc/telegram/\${method}\`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });`,
    sidecarCommands: [
      "# Leave running; it signs every request with the passport.",
      "passcontrol sidecar",
      "",
      "# In the tool's shell: GitHub clients read GITHUB_API_URL.",
      'eval "$(passcontrol env github)"',
      "",
      "# Telegram, by method name, through the same sidecar:",
      "curl -s http://127.0.0.1:8788/api/v1/svc/telegram/getMe",
    ].join("\n"),
  };
}
