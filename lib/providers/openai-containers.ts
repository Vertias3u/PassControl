// Which memory tier an OpenAI code interpreter or shell container runs at, and
// whether the request shows it at all. One rule, read by the hosted-tool pricer
// (hosted-tools.ts) and by the dollar-limit gate (lib/pricing.ts).
//
// A module of its own, with no imports, because hosted-tools.ts imports
// lib/pricing.ts: pricing.ts importing hosted-tools.ts back would be a cycle in
// which hosted-tools' top-level rates can be read before pricing.ts has run.

export type MemoryTier = "1g" | "4g" | "16g" | "64g";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function memoryTier(v: unknown): MemoryTier {
  return v === "4g" || v === "16g" || v === "64g" ? v : "1g";
}

/** The memory tier of an OpenAI container tool; "unknown" for a reused container. */
export function openaiContainerTier(tool: Record<string, unknown>): MemoryTier | "unknown" | null {
  if (tool.type === "code_interpreter") {
    if (typeof tool.container === "string") return "unknown";
    if (isRecord(tool.container) && tool.container.type === "auto") return memoryTier(tool.container.memory_limit);
    return null;
  }
  if (tool.type === "shell" && isRecord(tool.environment)) {
    if (tool.environment.type === "container_reference") return "unknown";
    if (tool.environment.type === "container_auto") return memoryTier(tool.environment.memory_limit);
  }
  return null;
}

/**
 * Whether this OpenAI body uses a container whose memory tier the request does not
 * show (a reused one). Under a dollar limit lib/pricing.ts refuses it as unpriced.
 */
export function openaiUnknownContainer(body: unknown): boolean {
  if (!isRecord(body) || !Array.isArray(body.tools)) return false;
  return body.tools.some((t) => isRecord(t) && openaiContainerTier(t) === "unknown");
}
