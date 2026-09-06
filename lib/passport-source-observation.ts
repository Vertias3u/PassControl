// Best-effort passport source observation. This is evidence, never an auth gate:
// callers must fail open if Redis or hashing is unavailable.
import type { Redis } from "@upstash/redis";

import { bytesToBase64url, utf8ToBytes } from "@/lib/encoding";

export const MAX_PASSPORT_SOURCE_FINGERPRINTS = 8;
export const MAX_PASSPORT_SOURCE_SIGNALS = 8;
export const PASSPORT_SOURCE_STATE_TTL_SECONDS = 45 * 24 * 60 * 60;
export const PASSPORT_SOURCE_STABILITY_SECONDS = 7 * 24 * 60 * 60;
export const PASSPORT_SOURCE_SIGNAL_KEY_PREFIX = "passport_source_signals:";

const ACTIVE_KEY_PREFIX = "passport_source_active:";
const FIRST_SEEN_KEY_PREFIX = "passport_source_first:";

export interface PassportSourceSignal {
  strength: "strong" | "medium";
  observedAt: string;
  countries: string[];
}

interface ObservationInput {
  agentId: string;
  ip: string;
  country: string | null;
  observedAt?: number;
  visaTtlSeconds: number;
  hashKey: CryptoKey;
}

interface ScoreMember {
  member: string;
  score: number;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const activeKey = (agentId: string) => `${ACTIVE_KEY_PREFIX}${agentId}`;
const firstSeenKey = (agentId: string) => `${FIRST_SEEN_KEY_PREFIX}${agentId}`;
export const passportSourceSignalKey = (agentId: string) =>
  `${PASSPORT_SOURCE_SIGNAL_KEY_PREFIX}${agentId}`;

function countryCode(value: string | null): string {
  const normalized = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : "ZZ";
}

function splitMember(value: string): { country: string; fingerprint: string } | null {
  const dot = value.indexOf(".");
  if (dot !== 2 || value.length <= 3) return null;
  const country = value.slice(0, dot);
  if (!/^[A-Z]{2}$/.test(country)) return null;
  return { country, fingerprint: value.slice(dot + 1) };
}

function scoreMembers(value: unknown): ScoreMember[] {
  if (!Array.isArray(value)) return [];
  const out: ScoreMember[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = value[index];
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const row = entry as Record<string, unknown>;
      if (typeof row.member === "string" && Number.isFinite(Number(row.score))) {
        out.push({ member: row.member, score: Number(row.score) });
      }
      continue;
    }
    if (typeof entry === "string" && Number.isFinite(Number(value[index + 1]))) {
      out.push({ member: entry, score: Number(value[index + 1]) });
      index += 1;
    }
  }
  return out.sort((left, right) => left.score - right.score);
}

export async function passportSourceFingerprint(
  scope: string,
  ip: string,
  key: CryptoKey
): Promise<string> {
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    arrayBuffer(utf8ToBytes(`passport-source:v1\0${scope}\0${ip}`))
  );
  return bytesToBase64url(new Uint8Array(digest));
}

function parsedSignal(value: unknown): PassportSourceSignal | null {
  let candidate = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const row = candidate as Record<string, unknown>;
  if (row.strength !== "strong" && row.strength !== "medium") return null;
  if (typeof row.observedAt !== "string" || !Number.isFinite(Date.parse(row.observedAt))) return null;
  if (!Array.isArray(row.countries)) return null;
  const countries = row.countries.filter(
    (country): country is string => typeof country === "string" && /^[A-Z]{2}$/.test(country)
  );
  if (countries.length === 0) return null;
  return { strength: row.strength, observedAt: row.observedAt, countries };
}

/**
 * Record one verified passport mint and return a ranked observation, if any.
 *
 * The two source sets are written before they are read. For concurrent mints,
 * at least the later read therefore sees both completed writes; a read-then-
 * write sequence could let both callers observe an empty set and miss the
 * overlap. Every set and signal list is capped and refreshed with one TTL.
 */
export async function observePassportSource(
  r: Redis,
  input: ObservationInput
): Promise<PassportSourceSignal | null> {
  const observedAt = input.observedAt ?? Date.now();
  const country = countryCode(input.country);
  const fingerprint = await passportSourceFingerprint(input.agentId, input.ip, input.hashKey);
  const member = `${country}.${fingerprint}`;
  const activeUntil = observedAt + Math.max(1, Math.floor(input.visaTtlSeconds)) * 1000;
  const active = activeKey(input.agentId);
  const first = firstSeenKey(input.agentId);

  const write = r.pipeline();
  write.zadd(active, { score: activeUntil, member });
  write.expire(active, PASSPORT_SOURCE_STATE_TTL_SECONDS);
  write.zadd(first, { nx: true }, { score: observedAt, member });
  write.expire(first, PASSPORT_SOURCE_STATE_TTL_SECONDS);
  const writeResults = await write.exec();
  const exactMemberWasAdded = Number((writeResults as unknown[])[2]) === 1;

  const read = r.pipeline();
  read.zrange(active, 0, -1, { withScores: true });
  read.zrange(first, 0, -1, { withScores: true });
  const [activeRaw, firstRaw] = await read.exec() as unknown[];
  const activeEntries = scoreMembers(activeRaw);
  const firstEntries = scoreMembers(firstRaw);

  const otherSameFingerprint = firstEntries.some((entry) => {
    const parsed = splitMember(entry.member);
    return parsed?.fingerprint === fingerprint && entry.member !== member;
  });
  const newFingerprint = exactMemberWasAdded && !otherSameFingerprint;

  const overlappingCountries = new Set<string>();
  if (country !== "ZZ") overlappingCountries.add(country);
  for (const entry of activeEntries) {
    if (entry.score < observedAt) continue;
    const parsed = splitMember(entry.member);
    if (!parsed || parsed.fingerprint === fingerprint || parsed.country === "ZZ") continue;
    if (parsed.country !== country) overlappingCountries.add(parsed.country);
  }

  let signal: PassportSourceSignal | null = null;
  if (country !== "ZZ" && overlappingCountries.size >= 2) {
    signal = {
      strength: "strong",
      observedAt: new Date(observedAt).toISOString(),
      countries: [...overlappingCountries].sort(),
    };
  } else if (newFingerprint) {
    const priorSources = firstEntries.filter((entry) => entry.member !== member);
    const stableBefore = observedAt - PASSPORT_SOURCE_STABILITY_SECONDS * 1000;
    if (priorSources.length > 0 && priorSources.every((entry) => entry.score <= stableBefore)) {
      signal = {
        strength: "medium",
        observedAt: new Date(observedAt).toISOString(),
        countries: [country],
      };
    }
  }

  const trimActive = activeEntries
    .slice(0, Math.max(0, activeEntries.length - MAX_PASSPORT_SOURCE_FINGERPRINTS))
    .map((entry) => entry.member);
  const trimFirst = firstEntries
    .slice(0, Math.max(0, firstEntries.length - MAX_PASSPORT_SOURCE_FINGERPRINTS))
    .map((entry) => entry.member);
  if (trimActive.length || trimFirst.length || signal) {
    const finish = r.pipeline();
    if (trimActive.length) finish.zrem(active, ...trimActive);
    if (trimFirst.length) finish.zrem(first, ...trimFirst);
    if (signal) {
      const signals = passportSourceSignalKey(input.agentId);
      finish.lpush(signals, JSON.stringify(signal));
      finish.ltrim(signals, 0, MAX_PASSPORT_SOURCE_SIGNALS - 1);
      finish.expire(signals, PASSPORT_SOURCE_STATE_TTL_SECONDS);
    }
    await finish.exec();
  }
  return signal;
}

export async function readPassportSourceSignals(
  r: Pick<Redis, "lrange">,
  agentId: string
): Promise<PassportSourceSignal[]> {
  const values = await r.lrange<unknown>(
    passportSourceSignalKey(agentId),
    0,
    MAX_PASSPORT_SOURCE_SIGNALS - 1
  );
  return values.flatMap((value) => {
    const signal = parsedSignal(value);
    return signal ? [signal] : [];
  });
}
