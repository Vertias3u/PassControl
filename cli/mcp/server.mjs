import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import { PROVIDERS } from "../config.mjs";
import { createGatewayClient } from "./gateway.mjs";

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1),
});

const usageSchema = z.record(z.string(), z.unknown());
const modelSchema = z.object({
  provider: z.string(),
  model: z.string(),
});

function toolError(error) {
  return {
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true,
  };
}

export function createMcpServer(options) {
  const gateway = createGatewayClient(options);
  const server = new McpServer(
    { name: "passcontrol", version: "0.2.0" },
    {
      instructions:
        "Use chat for governed model calls through PassControl. Every chat call is subject to the configured passport's scope, budget, and kill switches.",
    }
  );

  server.registerTool(
    "chat",
    {
      title: "Governed model chat",
      description:
        "Call a supported model through the PassControl gateway. The provider key stays in the gateway; passport scope, budget, and kill switches apply.",
      inputSchema: {
        provider: z.enum(PROVIDERS),
        model: z.string().min(1),
        messages: z.array(messageSchema).min(1),
        max_tokens: z.number().int().positive().optional(),
        temperature: z.number().min(0).max(2).optional(),
      },
      outputSchema: {
        text: z.string(),
        usage: usageSchema.optional(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const result = await gateway.chat(input);
        const structuredContent = {
          text: result.text,
          ...(result.usage ? { usage: result.usage } : {}),
        };
        return {
          content: [{ type: "text", text: result.text }],
          structuredContent,
        };
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "list_models",
    {
      title: "List scoped models",
      description:
        "List provider/model patterns in the gateway-issued scope for the configured passport.",
      outputSchema: { models: z.array(modelSchema) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const structuredContent = { models: await gateway.listModels() };
        return {
          content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
          structuredContent,
        };
      } catch (error) {
        return toolError(error);
      }
    }
  );

  return server;
}

export async function startMcpServer(options) {
  const server = createMcpServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}
