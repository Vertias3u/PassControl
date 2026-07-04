// Safe JSON body reader for control-plane writes: enforces application/json and a
// hard size cap (agent/kill payloads are tiny) before parsing.
const MAX_BYTES = 64 * 1024;

export type BodyResult =
  | { ok: true; body: any }
  | { ok: false; status: number; code: string };

export async function readJsonBody(req: Request): Promise<BodyResult> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (ct && !ct.includes("application/json")) {
    return { ok: false, status: 415, code: "unsupported_media_type" };
  }
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES) {
    return { ok: false, status: 413, code: "payload_too_large" };
  }
  const raw = await req.text();
  if (raw.length > MAX_BYTES) return { ok: false, status: 413, code: "payload_too_large" };
  if (!raw) return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, status: 400, code: "invalid_request" };
  }
}
