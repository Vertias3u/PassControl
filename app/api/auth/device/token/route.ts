// `passcontrol login` — redeem an approved device authorization.
//
// POST /api/auth/device/token
// body: { device_code }
// → 200 { api_key, prefix }        approved, and this is the ONLY time it is returned
//   202 { error: "authorization_pending" }
//   400 { error: "access_denied" } the operator pressed Deny
//   400 { error: "expired_token" } never existed, timed out, or already redeemed
//   429 { error: "slow_down" }     polling faster than the advertised interval
//
// Self-gating for the same reason as ../start: it lives outside /api/control/v1/
// because that wrapper demands the key this route exists to deliver.
export const runtime = "edge";

import { readBoundedBody } from "@/lib/http/bounded-body";
import { clientIp } from "@/lib/http/client-ip";
import { NextResponse } from "next/server";
import { open } from "@/lib/crypto/aesgcm";
import { sealContext } from "@/lib/crypto/seal-context";
import { hashDeviceCode, isDeviceCodeFormat } from "@/lib/device-codes";
import { captureSecurityEvent } from "@/lib/observability";
import { rateLimit, rateLimitFailClosed } from "@/lib/ratelimit";
import { readDeviceStatus, takeDeviceGrant } from "@/lib/state/device-auth";

// The CLI is told to poll at 1/s; allow headroom for jitter and retries, then
// answer slow_down rather than doing work.
const DEVICE_TOKEN_IP_LIMIT = 300;
const POLL_LIMIT = 120;
const POLL_WINDOW_S = 60;
const MAX_BODY_BYTES = 4 * 1024;

interface Grant {
  version: number;
  userId: string;
  token: string;
  prefix: string;
  expiresAt: number;
}

function parseGrant(value: string | null): Grant | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Grant;
    return parsed && typeof parsed.token === "string" && typeof parsed.userId === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request): Promise<Response> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (ct && !ct.includes("application/json")) {
    return NextResponse.json({ error: "unsupported_media_type" }, { status: 415 });
  }
  const bounded = await readBoundedBody(req, MAX_BODY_BYTES);
  if (!bounded.ok) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  const raw = bounded.text;
  let body: { device_code?: unknown } = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const deviceCode = String(body?.device_code ?? "");
  // Shape check before the hash, so a megabyte of junk never reaches SHA-256.
  if (!isDeviceCodeFormat(deviceCode)) {
    return NextResponse.json({ error: "expired_token" }, { status: 400 });
  }
  // Cloud review 2026-11-03, CP4: the per-code limit below never sees a flood of
  // fresh codes, each of which costs a Redis read. This per-IP ceiling, far above one
  // CLI's 1/s poll, clips that flood; it fails open, so the per-code limit stays the
  // fairness limit for many CLIs behind one CGNAT address.
  const ipLimit = await rateLimit(`device-token-ip:${clientIp(req)}`, DEVICE_TOKEN_IP_LIMIT, POLL_WINDOW_S);
  if (!ipLimit.success) {
    return NextResponse.json({ error: "slow_down" }, { status: 429 });
  }
  const hash = await hashDeviceCode(deviceCode);

  // Limit on the device_code, not the IP: a CLI behind CGNAT shares an IP with
  // strangers, and one polling client must not exhaust everyone else's budget.
  // Keyed by the HASH so the limiter's own key space never holds a live secret.
  const limit = await rateLimitFailClosed(`device-token:${hash}`, POLL_LIMIT, POLL_WINDOW_S);
  if (!limit.success) {
    return NextResponse.json({ error: "slow_down" }, { status: 429 });
  }

  const status = await readDeviceStatus(hash);
  if (status === null) {
    return NextResponse.json({ error: "expired_token" }, { status: 400 });
  }
  if (status === "denied") {
    return NextResponse.json({ error: "access_denied" }, { status: 400 });
  }
  if (status === "pending") {
    return NextResponse.json({ error: "authorization_pending" }, { status: 202 });
  }

  // Atomic. `getdel` and not get-then-del: two concurrent redemptions of one
  // captured device_code must not both succeed. See the note in device-auth.ts.
  const sealed = await takeDeviceGrant(hash);
  const grant = parseGrant(sealed ? await open(sealed, sealContext.deviceGrant(hash)) : null);
  if (!grant) {
    // Approved but nothing to collect: already redeemed, or the 120s window
    // lapsed. Both are "run login again", and neither should say which — the
    // difference is only useful to someone holding a stolen device_code.
    return NextResponse.json({ error: "expired_token" }, { status: 400 });
  }
  if (grant.expiresAt < Date.now()) {
    // No prefix, no token: ObservabilityContext is a fixed allowlist precisely so
    // a credential cannot be smuggled into telemetry by adding a field.
    captureSecurityEvent("device_grant_expired", {
      route: "/api/auth/device/token",
      code: "grant_expired",
    });
    return NextResponse.json({ error: "expired_token" }, { status: 400 });
  }

  return NextResponse.json(
    { api_key: grant.token, prefix: grant.prefix },
    { status: 200, headers: { "cache-control": "no-store" } }
  );
}
