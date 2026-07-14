import { decodeJwt } from "jose";
import { OPENAI_SHAPE_PROVIDERS, formatProxyError } from "../config.mjs";
import { createVisaClient } from "../visa-client.mjs";

const DEFAULT_ANTHROPIC_MAX_TOKENS = 1024;

const trimSlash = (value) => String(value ?? "").replace(/\/+$/, "");

function requestFor({ provider, model, messages, max_tokens, temperature }) {
  if (provider === "anthropic") {
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const providerMessages = messages.filter((message) => message.role !== "system");
    if (providerMessages.length === 0) {
      throw new Error("Anthropic chat requires at least one user or assistant message.");
    }

    return {
      path: "v1/messages",
      body: {
        model,
        max_tokens: max_tokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
        messages: providerMessages,
        ...(system ? { system } : {}),
        ...(temperature === undefined ? {} : { temperature }),
      },
    };
  }

  if (OPENAI_SHAPE_PROVIDERS.has(provider)) {
    return {
      path: "chat/completions",
      body: {
        model,
        messages,
        ...(max_tokens === undefined ? {} : { max_tokens }),
        ...(temperature === undefined ? {} : { temperature }),
      },
    };
  }

  throw new Error(`Provider ${provider} is not supported by PassControl MCP.`);
}

function extractAssistantText(provider, data) {
  if (provider === "anthropic") {
    const text = Array.isArray(data?.content)
      ? data.content
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("")
      : "";
    if (text) return text;
  } else {
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === "string" && content) return content;
    if (Array.isArray(content)) {
      const text = content
        .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
        .join("");
      if (text) return text;
    }
  }

  throw new Error(`${provider} returned no assistant text.`);
}

function proxyError(status, body) {
  if (status === 401) {
    const detail = String(body ?? "").trim();
    return `Gateway rejected the work visa with 401: ${detail}. Check the passport and gateway, then retry.`;
  }
  return formatProxyError(status, body);
}

function usageFrom(data) {
  return data?.usage && typeof data.usage === "object" && !Array.isArray(data.usage)
    ? data.usage
    : undefined;
}

function modelsFromVisa(visa) {
  let payload;
  try {
    payload = decodeJwt(visa);
  } catch {
    throw new Error("Gateway returned a work visa with an unreadable scope.");
  }

  if (!Array.isArray(payload.scope)) {
    throw new Error("Gateway work visa did not contain a model scope.");
  }

  return payload.scope.flatMap((entry) => {
    if (!entry || typeof entry.provider !== "string" || !Array.isArray(entry.models)) return [];
    return entry.models
      .filter((model) => typeof model === "string")
      .map((model) => ({ provider: entry.provider, model }));
  });
}

export function createGatewayClient({
  gateway,
  passportId,
  passportSecret,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  randomUUID = () => globalThis.crypto.randomUUID(),
  refreshSkewSeconds = 30,
}) {
  const baseUrl = trimSlash(gateway);
  const visas = createVisaClient({
    gateway: baseUrl,
    passportId,
    passportSecret,
    fetch: fetchImpl,
    now,
    randomUUID,
    refreshSkewSeconds,
    missingVisaMessage: "Challenge returned no visa.",
  });

  async function proxyChat(input, visa) {
    const { path, body } = requestFor(input);
    return fetchImpl(`${baseUrl}/api/v1/${input.provider}/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${visa}`,
      },
      body: JSON.stringify(body),
    });
  }

  return {
    async chat(input) {
      const response = await visas.fetchWithVisa((visa) => proxyChat(input, visa));
      if (!response.ok) throw new Error(proxyError(response.status, await response.text()));

      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error(`Gateway returned a non-JSON ${input.provider} response.`);
      }
      return {
        text: extractAssistantText(input.provider, data),
        usage: usageFrom(data),
      };
    },

    async listModels() {
      return modelsFromVisa(await visas.getVisa());
    },
  };
}
