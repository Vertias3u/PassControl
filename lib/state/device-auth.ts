// Device-authorization state for `passcontrol login` — RFC 8628 shape.
//
// Three records, because the flow has two parties that reach it by different
// handles and must not be able to reach each other's:
//
//   devauth:code:<userCode>          the BROWSER's handle. What the approval
//                                    screen resolves. Holds no credential.
//   devauth:device:<deviceCodeHash>  the CLI's handle. Carries only a status,
//                                    so the poll can distinguish pending from
//                                    denied from expired.
//   devauth:grant:<deviceCodeHash>   the sealed API key, for at most 120s.
//
// A `user_code` alone can never redeem: the grant is keyed by the hash of the
// device code, which only the CLI process holds. That is what makes the browser
// leg safe to expose to a clipboard, a screenshot, or someone reading over a
// shoulder.
//
// ── Nothing here is wrapped in a catch ────────────────────────────────────────
//
// A Redis fault must propagate, so approval and redemption FAIL CLOSED. This is
// the same posture as claimNonce and the opposite of the kill/suspend/policy
// reads, which fail open on purpose because a stale "not killed" is safer than a
// dead gateway. The asymmetry is deliberate (CLAUDE.md, trust boundary 3): an
// unreadable credential store means we did not authenticate anything, and the
// correct response to "we cannot tell" is to mint nothing.
import { captureSecurityEvent } from "../observability";
import { redis } from "./redis";

const k = {
  code: (userCode: string) => `devauth:code:${userCode}`,
  device: (deviceCodeHash: string) => `devauth:device:${deviceCodeHash}`,
  grant: (deviceCodeHash: string) => `devauth:grant:${deviceCodeHash}`,
};

/** How long an unapproved login stays open. RFC 8628 suggests ~10 minutes. */
export const DEVICE_CODE_TTL_S = 600;
/**
 * How long an approved-but-unredeemed grant survives. Short: the CLI is already
 * polling when approval lands, so the normal case redeems within one interval.
 * A long window here is just a wider replay target for a stolen device_code.
 */
export const GRANT_TTL_S = 120;
/**
 * Failed *resolutions of a real code* before the record is destroyed.
 *
 * Read what this does and does not bound. It does NOT bound enumeration: a guess
 * that misses resolves nothing, so there is no record on which to count it. The
 * control for misses is the fail-closed per-user rate limit at the call site,
 * plus the 600s TTL. What this bounds is a code that has already been found —
 * someone repeatedly loading the approval screen against a live login they do
 * not own — and it fails safe by destroying the login rather than locking it.
 */
export const MAX_CODE_ATTEMPTS = 5;

export type DeviceStatus = "pending" | "approved" | "denied";

export interface PendingDevice {
  deviceCodeHash: string;
  clientName: string;
  ip: string;
  createdAt: number;
  attempts: number;
}

/**
 * `@upstash/redis` JSON-parses every response, so a value written as JSON text
 * comes back already parsed — see the long note on `asCachedString` in redis.ts,
 * and the production incident it records. Reading through one narrow parser here
 * means this module never has to care which of the two it got.
 */
function parseRecord<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value as T;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** Open a login. Both records are written before the CLI is told to poll. */
export async function startDeviceAuthorization(input: {
  userCode: string;
  deviceCodeHash: string;
  clientName: string;
  ip: string;
}): Promise<void> {
  const pending: PendingDevice = {
    deviceCodeHash: input.deviceCodeHash,
    clientName: input.clientName,
    ip: input.ip,
    createdAt: Date.now(),
    attempts: 0,
  };
  await redis().set(k.code(input.userCode), JSON.stringify(pending), { ex: DEVICE_CODE_TTL_S });
  await redis().set(
    k.device(input.deviceCodeHash),
    JSON.stringify({ status: "pending", userCode: input.userCode }),
    { ex: DEVICE_CODE_TTL_S }
  );
}

/**
 * Resolve a user code for the approval screen, counting the attempt.
 *
 * This is the brute-force oracle of the whole design — it is the call that
 * answers "is this code real?" — which is why its caller gates BEFORE reaching
 * it and rate-limits fail-closed around it.
 */
export async function resolveUserCode(
  userCode: string,
  { count = true }: { count?: boolean } = {}
): Promise<PendingDevice | null> {
  const raw = await redis().get<unknown>(k.code(userCode));
  const pending = parseRecord<PendingDevice>(raw);
  if (!pending) return null;
  // `count: false` for the approve path, and ONLY there. The counter bounds
  // PROBING, and an approve is not a probe: it follows a resolution that already
  // paid, it is behind the strict MFA gate and the fail-closed limiter, and it
  // deletes the record moments later anyway.
  //
  // Charging it made one Continue-then-Approve cost two attempts, so the real
  // budget was 2.5 approvals rather than 5 — and an operator who re-read their
  // terminal a couple of times had their login destroyed at the exact moment they
  // pressed Approve, surfacing as "that code is not valid". Measured, not guessed.
  if (!count) return pending;

  const attempts = (pending.attempts ?? 0) + 1;
  if (attempts > MAX_CODE_ATTEMPTS) {
    // Destroy rather than lock: a login nobody can complete is a login an
    // attacker cannot complete either, and the operator simply re-runs the
    // command. Leaving it readable-but-frozen would keep the oracle alive.
    //
    // Worth a signal, because the benign explanation is thin: a real operator
    // resolves their code once or twice. Six resolutions of ONE live code means
    // either a confused human or someone working through a live login they do
    // not own. Carries no code and no tenant — ObservabilityContext is a fixed
    // allowlist for exactly that reason.
    captureSecurityEvent("device_code_attempts_exhausted", {
      route: "lib/state/device-auth",
      code: "attempt_cap",
    });
    await destroyDeviceAuthorization(userCode, pending.deviceCodeHash);
    return null;
  }
  // Preserve the original TTL rather than restarting it — a caller hammering
  // this must not be able to keep a login alive indefinitely.
  const ttl = await redis().ttl(k.code(userCode));
  await redis().set(k.code(userCode), JSON.stringify({ ...pending, attempts }), {
    ex: ttl > 0 ? ttl : DEVICE_CODE_TTL_S,
  });
  return { ...pending, attempts };
}

/** Approve: publish the sealed grant, then flip the CLI-visible status. */
export async function approveDeviceAuthorization(input: {
  userCode: string;
  deviceCodeHash: string;
  sealedGrant: string;
}): Promise<void> {
  // Grant first. If the status flip fails, the CLI keeps polling `pending` and
  // the grant expires unread — nobody is handed a key they did not ask for. The
  // reverse order could tell the CLI "approved" with nothing to collect.
  await redis().set(k.grant(input.deviceCodeHash), input.sealedGrant, { ex: GRANT_TTL_S });
  await redis().set(
    k.device(input.deviceCodeHash),
    JSON.stringify({ status: "approved", userCode: input.userCode }),
    { ex: GRANT_TTL_S }
  );
  // The browser handle is single-use.
  await redis().del(k.code(input.userCode));
}

/** Deny: the CLI stops immediately rather than waiting out the TTL. */
export async function denyDeviceAuthorization(input: {
  userCode: string;
  deviceCodeHash: string;
}): Promise<void> {
  await redis().set(
    k.device(input.deviceCodeHash),
    JSON.stringify({ status: "denied", userCode: input.userCode }),
    { ex: DEVICE_CODE_TTL_S }
  );
  await redis().del(k.code(input.userCode));
}

/** Destroy both handles — the attempt cap, and the deny path's cleanup. */
export async function destroyDeviceAuthorization(
  userCode: string,
  deviceCodeHash: string
): Promise<void> {
  await redis().del(k.code(userCode));
  await redis().del(k.device(deviceCodeHash));
  await redis().del(k.grant(deviceCodeHash));
}

/** What the CLI's poll sees. `null` means expired or never existed. */
export async function readDeviceStatus(deviceCodeHash: string): Promise<DeviceStatus | null> {
  const raw = await redis().get<unknown>(k.device(deviceCodeHash));
  const record = parseRecord<{ status?: DeviceStatus }>(raw);
  const status = record?.status;
  return status === "pending" || status === "approved" || status === "denied" ? status : null;
}

/**
 * Redeem the grant EXACTLY once — atomically.
 *
 * `getdel` and not `get` then `del`. The distinction is not academic: this
 * module's neighbour `takeKeyImport` (redis.ts) was written as that GET-then-DEL
 * pair under a docstring already claiming "EXACTLY once" — two concurrent callers
 * both read before either deleted, and both walked away with the value. It has
 * since been fixed the same way, with tests/key-import-atomic.test.ts pinning it.
 * Here the same defect would hand one control-plane key to two holders, one of
 * whom is whoever replayed a captured device_code.
 *
 * One round trip, decided server-side, so concurrency cannot split it.
 */
export async function takeDeviceGrant(deviceCodeHash: string): Promise<string | null> {
  const sealed = await redis().getdel<unknown>(k.grant(deviceCodeHash));
  if (sealed === null || sealed === undefined) return null;
  return typeof sealed === "string" ? sealed : JSON.stringify(sealed);
}
