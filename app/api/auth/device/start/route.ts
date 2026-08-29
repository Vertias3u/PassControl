// `passcontrol login` — open a device authorization (RFC 8628 shape).
//
// POST /api/auth/device/start
// body: { client_name?: string }
// → { device_code, user_code, verification_uri, expires_in, interval }
//
// Deliberately NOT under /api/control/v1/. That prefix's `control()` wrapper
// requires an API key, and this pair of routes exists to hand one out — so they
// gate themselves. `middleware.ts` excludes /api/* (agents authenticate with a
// Bearer visa, not a cookie), so nothing upstream gates them either. Read the
// limiter below as the whole perimeter, because it is.
export const runtime = "edge";

import { NextResponse } from "next/server";
import { generateDeviceCode, generateUserCode, hashDeviceCode } from "@/lib/device-codes";
import { rateLimitFailClosed } from "@/lib/ratelimit";
import { DEVICE_CODE_TTL_S, startDeviceAuthorization } from "@/lib/state/device-auth";

// Tight, because each admitted call parks two records in Redis and burns a code
// out of the live namespace. A person runs this once; a script runs it forever.
const START_LIMIT = 10;
const START_WINDOW_S = 60;
// The CLI polls on this; the server owns it so the interval can be widened
// without shipping a new CLI.
const POLL_INTERVAL_S = 1;
const MAX_BODY_BYTES = 4 * 1024;
const CLIENT_NAME_MAX = 60;

function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

/**
 * The client name is shown on the approval screen, so it is attacker-controlled
 * text rendered next to a Approve button. Strip it to a boring character set
 * rather than trusting React's escaping alone: the risk here is not script
 * injection, it is a name like "Chrome — verified by PassControl" dressing up a
 * phishing prompt with punctuation that looks like chrome.
 */
function cleanClientName(value: unknown): string {
  const name = String(value ?? "")
    .replace(/[^A-Za-z0-9 ._-]/gu, " ")
    // Collapse runs. Stripping characters to nothing leaves the gaps they sat in,
    // and "Chrome        official" is the same visual trick as the punctuation
    // this function exists to remove — a long gap reads as a column break.
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, CLIENT_NAME_MAX)
    .trim();
  return name || "unknown device";
}

export async function POST(req: Request): Promise<Response> {
  const ip = clientIp(req);
  // Fail CLOSED. This is the unauthenticated credential edge — the same case
  // lib/ratelimit.ts's header argues for. An unreadable Redis here must not
  // degrade into an unmetered code-minting endpoint, and since the flow cannot
  // complete without Redis anyway, refusing costs a caller nothing real.
  const limit = await rateLimitFailClosed(`device-start:${ip}`, START_LIMIT, START_WINDOW_S);
  if (!limit.success) {
    return NextResponse.json({ error: "slow_down" }, { status: 429 });
  }

  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (ct && !ct.includes("application/json")) {
    return NextResponse.json({ error: "unsupported_media_type" }, { status: 415 });
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  let body: { client_name?: unknown } = {};
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
  }

  // BOTH codes are minted here, server-side. A client-chosen user_code would let
  // an attacker pick a code, phish an operator into approving it, and collect the
  // key — the entire flow's threat model in one field.
  const userCode = generateUserCode();
  const deviceCode = generateDeviceCode();

  await startDeviceAuthorization({
    userCode,
    deviceCodeHash: await hashDeviceCode(deviceCode),
    clientName: cleanClientName(body?.client_name),
    ip,
  });

  const origin = new URL(req.url).origin;
  return NextResponse.json(
    {
      device_code: deviceCode,
      user_code: userCode,
      // No fragment and no query. The operator carries the code across by hand
      // (pasted or typed) — that act IS the channel binding, and a pre-filled
      // link removes it exactly where it matters. tests/cli-login-shape.test.ts
      // holds this shape on the CLI side.
      verification_uri: `${origin}/dashboard/cli`,
      expires_in: DEVICE_CODE_TTL_S,
      interval: POLL_INTERVAL_S,
    },
    { status: 200, headers: { "cache-control": "no-store" } }
  );
}
