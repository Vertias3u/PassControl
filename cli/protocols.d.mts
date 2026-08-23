export interface ProtocolRange {
  minimum: number;
  maximum: number;
}

export const CONTROL_API_PROTOCOL: ProtocolRange;
export const GATEWAY_API_PROTOCOL: ProtocolRange;
export const RECEIPT_PROTOCOL: ProtocolRange;
export const AGENT_TOKEN_PROTOCOL: ProtocolRange;
export const WORKSPACE_EXPORT_PROTOCOL: ProtocolRange;
export const CLIENT_PROTOCOLS: Readonly<Record<string, ProtocolRange>>;
export function compareProtocolRanges(client: ProtocolRange, server: unknown): "compatible" | "partial" | "update-required" | "unavailable";
export function compareProtocolSets(serverProtocols: unknown): {
  state: "compatible" | "partial" | "update-required" | "unavailable";
  checks: Array<{ name: string; client: ProtocolRange; server: unknown; state: "compatible" | "partial" | "update-required" | "unavailable" }>;
};
