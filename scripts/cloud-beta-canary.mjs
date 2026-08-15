#!/usr/bin/env node

// Active, post-deploy Cloud invite-beta canary.
//
// This command makes two deliberately billable model calls and three refused
// calls. It never deploys, provisions, rotates, revokes, edits a policy, or
// changes a budget. The operator prepares disposable canary identities first;
// this script then proves the deployed read/write path and its durable evidence.
import { pathToFileURL } from "node:url";

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { ed25519 } from "@noble/curves/ed25519";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { createClient } from "@supabase/supabase-js";

import { createVisaClient } from "../cli/visa-client.mjs";

const CONFIRM_FLAG = "--confirm-billable-production-canary";
const DIRECT_KEY_RE = /^pc_agent_[A-Za-z0-9_-]{43}$/u;
const CONTROL_KEY_RE = /^pc_[A-Za-z0-9_-]{20,80}$/u;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const RECEIPT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const stripSlash = (value) => String(value ?? "").replace(/\/+$/u, "");
const present = (value) => typeof value === "string" && value.trim().length > 0;

function isBareHttpsOrigin(value) {
  if (!present(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.pathname === "/"
      && !url.search
      && !url.hash
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function decode32(value) {
  if (!present(value)) return null;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.length === 32 && bytes.toString("base64url") === value.replace(/=+$/u, "")
      ? bytes
      : null;
  } catch {
    return null;
  }
}

/** Configuration diagnostics are names and requirements only; never values. */
export function checkCanaryConfiguration(env) {
  const problems = [];
  if (!isBareHttpsOrigin(env.PASSCONTROL_CANARY_ORIGIN)) {
    problems.push("PASSCONTROL_CANARY_ORIGIN: must be the bare HTTPS deployed origin");
  }
  if (!new Set(["openai", "anthropic"]).has(env.PASSCONTROL_CANARY_PROVIDER)) {
    problems.push("PASSCONTROL_CANARY_PROVIDER: must be openai or anthropic");
  }
  for (const name of ["PASSCONTROL_CANARY_MODEL", "PASSCONTROL_CANARY_SCOPE_DENIED_MODEL"]) {
    if (!MODEL_RE.test(String(env[name] ?? ""))) problems.push(`${name}: must be a concrete provider model id`);
  }
  if (
    present(env.PASSCONTROL_CANARY_MODEL)
    && env.PASSCONTROL_CANARY_MODEL === env.PASSCONTROL_CANARY_SCOPE_DENIED_MODEL
  ) {
    problems.push("PASSCONTROL_CANARY_SCOPE_DENIED_MODEL: must differ from the allowed canary model");
  }
  for (const name of [
    "PASSCONTROL_CANARY_DIRECT_KEY",
    "PASSCONTROL_CANARY_BUDGET_KEY",
    "PASSCONTROL_CANARY_REVOKED_KEY",
  ]) {
    if (!DIRECT_KEY_RE.test(String(env[name] ?? ""))) problems.push(`${name}: must be a complete Direct Agent Key`);
  }
  const directKeys = new Set([
    env.PASSCONTROL_CANARY_DIRECT_KEY,
    env.PASSCONTROL_CANARY_BUDGET_KEY,
    env.PASSCONTROL_CANARY_REVOKED_KEY,
  ]);
  if (directKeys.size !== 3) problems.push("Direct Agent canary keys: happy, budget, and revoked credentials must be distinct");

  const passportId = decode32(env.PASSCONTROL_CANARY_PASSPORT_ID);
  const passportSecret = decode32(env.PASSCONTROL_CANARY_PASSPORT_SECRET);
  if (!passportId) problems.push("PASSCONTROL_CANARY_PASSPORT_ID: must be a base64url Ed25519 public key");
  if (!passportSecret) problems.push("PASSCONTROL_CANARY_PASSPORT_SECRET: must be a base64url 32-byte Ed25519 seed");
  if (passportId && passportSecret) {
    const derived = Buffer.from(ed25519.getPublicKey(passportSecret)).toString("base64url");
    if (derived !== env.PASSCONTROL_CANARY_PASSPORT_ID) {
      problems.push("Passport canary credentials: public id does not match the private seed");
    }
  }

  if (!present(env.PASSCONTROL_CANARY_EMAIL)) problems.push("PASSCONTROL_CANARY_EMAIL: required");
  if (!present(env.PASSCONTROL_CANARY_PASSWORD)) problems.push("PASSCONTROL_CANARY_PASSWORD: required");
  try {
    const url = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    if (url.protocol !== "https:") throw new Error("not https");
  } catch {
    problems.push("NEXT_PUBLIC_SUPABASE_URL: must be the production HTTPS Supabase URL");
  }
  if (!present(env.NEXT_PUBLIC_SUPABASE_ANON_KEY)) problems.push("NEXT_PUBLIC_SUPABASE_ANON_KEY: required");
  if (!CONTROL_KEY_RE.test(String(env.PASSCONTROL_API_KEY ?? ""))) {
    problems.push("PASSCONTROL_API_KEY: a read-scoped control-plane key is required");
  }
  const budgetMax = Number(env.PASSCONTROL_CANARY_BUDGET_MAX_TOKENS ?? "8192");
  if (!Number.isInteger(budgetMax) || budgetMax < 64 || budgetMax > 200_000) {
    problems.push("PASSCONTROL_CANARY_BUDGET_MAX_TOKENS: must be an integer from 64 to 200000");
  }
  return problems;
}

function responseHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : null;
  return Array.isArray(value) ? value[0] ?? null : typeof value === "string" ? value : null;
}

/** One request through the exact official SDK and base URL the wizard emits. */
export async function runProviderSdkCall({
  origin,
  provider,
  model,
  credential,
  maxTokens,
  allowHttpForTests = false,
  fetchImpl,
}) {
  const base = stripSlash(origin);
  if (!allowHttpForTests && !isBareHttpsOrigin(base)) throw new Error("unsafe_canary_origin");
  try {
    if (provider === "anthropic") {
      const client = new Anthropic({
        baseURL: `${base}/api/v1/anthropic`,
        apiKey: credential,
        maxRetries: 0,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      });
      const result = await client.messages.create({
        model,
        max_tokens: maxTokens ?? 8,
        messages: [{ role: "user", content: "Reply with the single word canary." }],
      }).withResponse();
      return {
        status: result.response.status,
        receiptId: responseHeader(result.response.headers, "x-passcontrol-receipt-id"),
      };
    }

    const client = new OpenAI({
      baseURL: `${base}/api/v1/openai/v1`,
      apiKey: credential,
      maxRetries: 0,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
    const request = {
      model,
      messages: [{ role: "user", content: "Reply with the single word canary." }],
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    };
    const result = await client.chat.completions.create(request).withResponse();
    return {
      status: result.response.status,
      receiptId: responseHeader(result.response.headers, "x-passcontrol-receipt-id"),
    };
  } catch (error) {
    return {
      status: Number(error?.status ?? 0),
      receiptId: responseHeader(error?.headers, "x-passcontrol-receipt-id"),
    };
  }
}

async function checkPublicSurface(config) {
  const login = await fetch(`${config.origin}/login`, { redirect: "manual" });
  if (login.status < 200 || login.status >= 400) throw new Error("login_surface_unavailable");
  const jwks = await fetch(`${config.origin}/.well-known/jwks.json`, { cache: "no-store" });
  if (!jwks.ok) throw new Error("jwks_unavailable");
  const body = await jwks.json().catch(() => null);
  if (!Array.isArray(body?.keys) || body.keys.length === 0) throw new Error("jwks_empty");
}

async function checkLogin(config) {
  const auth = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await auth.auth.signInWithPassword({
    email: config.email,
    password: config.password,
  });
  if (error || !data.user || !data.session) throw new Error("canary_login_failed");
  const verified = await auth.auth.getUser(data.session.access_token);
  if (verified.error || verified.data.user?.id !== data.user.id) throw new Error("canary_session_unverified");
  await auth.auth.signOut({ scope: "local" });
}

async function mintPassportVisa(config) {
  const client = createVisaClient({
    gateway: config.origin,
    passportId: config.passportId,
    passportSecret: config.passportSecret,
  });
  return client.getVisa();
}

async function readReceipt(config, receiptId) {
  if (!RECEIPT_ID_RE.test(String(receiptId ?? ""))) throw new Error("missing_receipt_id");
  const endpoint = `${config.origin}/api/control/v1/receipts/${receiptId}`;
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${config.controlKey}` },
      cache: "no-store",
    });
    if (response.ok) {
      const body = await response.json().catch(() => null);
      if (!body?.data) throw new Error("receipt_response_malformed");
      return body.data;
    }
    if (response.status !== 404) throw new Error("receipt_read_failed");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("receipt_not_durable");
}

function assertStoredRecord(record, expected, config) {
  if (!present(record?.receipt)) throw new Error("signed_receipt_missing");
  if (record.status !== expected.status) throw new Error("stored_status_mismatch");
  if (expected.authMethod === "direct_key") {
    if (
      record.auth_method !== "direct_key"
      || record.passport_id !== null
      || record.jti !== null
      || !present(record.agent_access_key_id)
      || !present(record.credential_use_id)
    ) throw new Error("direct_identity_shape_invalid");
  } else if (
    record.auth_method !== "passport"
    || record.passport_id !== config.passportId
    || !present(record.jti)
    || record.agent_access_key_id !== null
    || record.credential_use_id !== null
  ) {
    throw new Error("passport_identity_shape_invalid");
  }
}

async function verifyReceipt(record, expected, config) {
  const header = decodeProtectedHeader(record.receipt);
  if (header.alg !== "EdDSA" || header.typ !== "passcontrol-receipt+jwt") {
    throw new Error("receipt_header_invalid");
  }
  const jwks = createRemoteJWKSet(new URL("/.well-known/jwks.json", config.origin));
  const { payload } = await jwtVerify(record.receipt, jwks, {
    algorithms: ["EdDSA"],
    issuer: config.origin,
  });
  if (payload.jti !== expected.receiptId || payload.res?.status !== expected.status) {
    throw new Error("receipt_claims_do_not_match_row");
  }
  if (expected.authMethod === "direct_key") {
    if (
      payload.ver !== 2
      || payload.auth?.kind !== "direct_key"
      || "vjti" in payload
    ) throw new Error("direct_identity_shape_invalid");
  } else if (
    payload.ver !== 1
    || present(payload.auth?.kind)
    || !present(payload.vjti)
  ) {
    throw new Error("passport_identity_shape_invalid");
  }
  return payload;
}

function configFromEnvironment(env) {
  return {
    origin: stripSlash(env.PASSCONTROL_CANARY_ORIGIN),
    provider: env.PASSCONTROL_CANARY_PROVIDER,
    model: env.PASSCONTROL_CANARY_MODEL,
    deniedModel: env.PASSCONTROL_CANARY_SCOPE_DENIED_MODEL,
    directKey: env.PASSCONTROL_CANARY_DIRECT_KEY,
    budgetKey: env.PASSCONTROL_CANARY_BUDGET_KEY,
    revokedKey: env.PASSCONTROL_CANARY_REVOKED_KEY,
    budgetMaxTokens: Number(env.PASSCONTROL_CANARY_BUDGET_MAX_TOKENS ?? "8192"),
    passportId: env.PASSCONTROL_CANARY_PASSPORT_ID,
    passportSecret: env.PASSCONTROL_CANARY_PASSPORT_SECRET,
    email: env.PASSCONTROL_CANARY_EMAIL,
    password: env.PASSCONTROL_CANARY_PASSWORD,
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
    supabaseAnonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    controlKey: env.PASSCONTROL_API_KEY,
  };
}

function assertCall(result, status, needsReceipt = true) {
  if (!result || result.status !== status) throw new Error(`unexpected_http_${result?.status ?? 0}`);
  if (needsReceipt && !present(result.receiptId)) throw new Error("receipt_header_missing");
  if (!needsReceipt && present(result.receiptId)) throw new Error("unexpected_receipt_for_pre_auth_refusal");
}

/** Run every release-canary claim. Dependencies are injectable only for tests. */
export async function runCloudBetaCanary(env, overrides = {}) {
  const problems = checkCanaryConfiguration(env);
  if (problems.length) throw new Error(`configuration_invalid:${problems.join("|")}`);
  const config = configFromEnvironment(env);
  const dependencies = {
    checkPublicSurface,
    checkLogin,
    mintPassportVisa,
    providerCall: runProviderSdkCall,
    readReceipt,
    verifyReceipt,
    progress: () => {},
    ...overrides,
  };
  const step = (label) => dependencies.progress(label);

  step("public surface and JWKS");
  await dependencies.checkPublicSurface(config);
  step("production login and server-validated session");
  await dependencies.checkLogin(config);

  step("Direct Agent call through official SDK");
  const direct = await dependencies.providerCall({
    origin: config.origin,
    provider: config.provider,
    model: config.model,
    credential: config.directKey,
  });
  assertCall(direct, 200);
  const directRecord = await dependencies.readReceipt(config, direct.receiptId);
  assertStoredRecord(directRecord, { status: "ok", authMethod: "direct_key" }, config);
  await dependencies.verifyReceipt(directRecord, {
    receiptId: direct.receiptId,
    status: "ok",
    authMethod: "direct_key",
  }, config);

  step("passport challenge and regression call through official SDK");
  const visa = await dependencies.mintPassportVisa(config);
  const passport = await dependencies.providerCall({
    origin: config.origin,
    provider: config.provider,
    model: config.model,
    credential: visa,
  });
  assertCall(passport, 200);
  const passportRecord = await dependencies.readReceipt(config, passport.receiptId);
  assertStoredRecord(passportRecord, { status: "ok", authMethod: "passport" }, config);
  await dependencies.verifyReceipt(passportRecord, {
    receiptId: passport.receiptId,
    status: "ok",
    authMethod: "passport",
  }, config);

  step("scope refusal and durable blocked_scope receipt");
  const scope = await dependencies.providerCall({
    origin: config.origin,
    provider: config.provider,
    model: config.deniedModel,
    credential: config.directKey,
  });
  assertCall(scope, 403);
  const scopeRecord = await dependencies.readReceipt(config, scope.receiptId);
  assertStoredRecord(scopeRecord, { status: "blocked_scope", authMethod: "direct_key" }, config);
  await dependencies.verifyReceipt(scopeRecord, {
    receiptId: scope.receiptId,
    status: "blocked_scope",
    authMethod: "direct_key",
  }, config);

  step("budget refusal and durable blocked_budget receipt");
  const budget = await dependencies.providerCall({
    origin: config.origin,
    provider: config.provider,
    model: config.model,
    credential: config.budgetKey,
    maxTokens: config.budgetMaxTokens,
  });
  assertCall(budget, 402);
  const budgetRecord = await dependencies.readReceipt(config, budget.receiptId);
  assertStoredRecord(budgetRecord, { status: "blocked_budget", authMethod: "direct_key" }, config);
  await dependencies.verifyReceipt(budgetRecord, {
    receiptId: budget.receiptId,
    status: "blocked_budget",
    authMethod: "direct_key",
  }, config);

  step("revoked Direct Agent Key refused before governance");
  const revoked = await dependencies.providerCall({
    origin: config.origin,
    provider: config.provider,
    model: config.model,
    credential: config.revokedKey,
  });
  assertCall(revoked, 401, false);

  return { ok: true, billableCalls: 2, refusalChecks: 3 };
}

async function main() {
  if (!process.argv.slice(2).includes(CONFIRM_FLAG)) {
    console.error(`✗ Refusing active production calls without ${CONFIRM_FLAG}`);
    console.error("  This canary performs two real provider calls and writes normal production audit rows.");
    process.exitCode = 1;
    return;
  }
  const problems = checkCanaryConfiguration(process.env);
  if (problems.length) {
    console.error(problems.map((problem) => `✗ ${problem}`).join("\n"));
    process.exitCode = 1;
    return;
  }
  try {
    const result = await runCloudBetaCanary(process.env, {
      progress: (label) => console.log(`→ ${label}`),
    });
    console.log(`✓ Cloud beta canary passed — ${result.billableCalls} provider calls, ${result.refusalChecks} refusal checks`);
  } catch (error) {
    const code = String(error?.message ?? "canary_failed").split(":", 1)[0].replace(/[^a-z0-9_-]/giu, "").slice(0, 80);
    console.error(`✗ Cloud beta canary failed (${code || "canary_failed"}).`);
    console.error("  Stop external invites. Roll back the application first; preserve migration 0023 and all evidence rows.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
