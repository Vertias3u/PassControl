// The end-to-end proof: does this passport actually govern a call, and can a
// stranger check that it did?
//
// Extracted from `passcontrol login` so `doctor --deep` runs the SAME chain
// rather than a second one that drifts. Before this, doctor stopped at "visa
// mint works" — which proves the passport authenticates and nothing about
// scope, budget, the proxy, or receipts. The most useful diagnostic in the tool
// was the one thing login already did better.
//
// Every leg is existing surface:
//   challenge -> visa   cli/visa-client.mjs (the same signer the sidecar uses)
//   demo call           app/api/v1/[provider]/[...path]/route.ts, keyless
//   receipt row         GET /api/control/v1/receipts/{id}
//   verification        cli/verify.mjs, the same code `passcontrol verify` runs
import { ok, step, warn } from "./config.mjs";
import { createVisaClient } from "./visa-client.mjs";
import { verifyReceipt } from "./verify.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The proxy answers BEFORE its receipt row exists.
 *
 * Signing and storing the audit row happen after the response, deliberately, so
 * a governed call is never slowed by its own paperwork. The receipt id in the
 * response header is therefore a promise that the row WILL exist, not a claim
 * that it does — and a single immediate read loses that race. Codex reproduced
 * it deterministically by holding the background write until the first read
 * finished.
 *
 * What made it worth fixing rather than tolerating is how it fails: that 404 is
 * the same answer a gateway gives when it stores no receipts at all, so the
 * operator is told the deployment signs nothing, on the one screen they read as
 * proof that it does.
 *
 * Bounded to five attempts inside ~1.75s, and ONLY on 404. A 401 is the wrong
 * key, a 429 is a limiter that retrying would only anger, and a 5xx is not
 * something a login should sit through. Exhausting the attempts falls through
 * to the caller's existing "no receipt was stored" branch, which by then is a
 * fair description.
 *
 * Exported because the policy IS the contract: the number of attempts, and the
 * fact that only a 404 earns one, are what separate a row still being written
 * from a wrong key or a limiter that retrying would only anger.
 */
const RECEIPT_RETRY_DELAYS_MS = [120, 240, 480, 900];

export async function fetchReceiptRow(origin, apiKey, receiptId, fetchImpl, wait) {
  const url = `${origin}/api/control/v1/receipts/${encodeURIComponent(receiptId)}`;
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) {
      const parsed = await res.json().catch(() => null);
      return parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
    }
    if (res.status !== 404) {
      throw new Error(`Control plane refused GET /receipts/${receiptId} (${res.status}).`);
    }
    if (attempt >= RECEIPT_RETRY_DELAYS_MS.length) return null;
    await wait(RECEIPT_RETRY_DELAYS_MS[attempt]);
  }
}

/**
 * End the command with the product working, not with homework.
 *
 * `login` used to sign off with homework — go and make a call yourself. This
 * runs it for them, and then does the part nothing else on the market does:
 * fetches the SIGNED RECEIPT for that call and verifies the signature locally,
 * against the gateway's published JWKS.
 *
 * Nothing here is new server surface. Every leg already existed:
 *   challenge → visa      cli/visa-client.mjs (the same signer the sidecar uses)
 *   demo call             app/api/v1/[provider]/[...path]/route.ts
 *   receipt row           GET /api/control/v1/receipts/{id}
 *   verification          cli/verify.mjs, the same code `passcontrol verify` runs
 *
 * `createVisaClient` rather than a local ed25519.sign: it re-validates the
 * origin at the point of signature, which is the guard its own header explains
 * is easy to leave behind when a new caller copies the signing lines instead.
 *
 * ── This function must never throw ──────────────────────────────────────────
 *
 * In login, the agent, the key and the config all already exist by the time
 * this runs — the command has SUCCEEDED. A proof that could turn that into a
 * non-zero exit would be a demo that costs people their setup. In doctor, a
 * throwing diagnostic is simply a bad diagnostic. So every branch degrades to
 * a quieter message and returns, and it wraps ITSELF rather than trusting each
 * caller to remember.
 */
export async function proveItWorks({
  origin,
  passportId,
  passportSecret,
  keyStorage = null,
  apiKey,
  fetchImpl,
  wait = sleep,
}) {
  const proof = { visa: false, call: false, receipt: null };
  try {
    const visas = createVisaClient({
      gateway: origin,
      passportId,
      passportSecret,
      keyStorage,
      fetch: fetchImpl,
    });
    const visa = await visas.getVisa();
    proof.visa = true;
    ok("minted a visa with the passport this machine just created");

    const res = await fetchImpl(`${origin}/api/v1/demo/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${visa}` },
      body: JSON.stringify({
        model: "demo-1",
        max_tokens: 32,
        messages: [{ role: "user", content: "Say hello in three words." }],
      }),
    });

    if (!res.ok) {
      // 404 is the ordinary answer from a self-hosted gateway that has not set
      // PASSCONTROL_DEMO=1 — a correctly configured gateway, not a fault. Say so
      // in those words, because "404" here would read as something being broken.
      proof.reason = res.status === 404 ? "demo_unavailable" : `call_${res.status}`;
      step(
        res.status === 404
          ? "This gateway has no keyless demo provider, so there was nothing free to call."
          : `The demo call answered ${res.status}; your passport is still fine.`
      );
      step('Add a provider key in the Control Tower, then:  passcontrol call "hi"');
      return proof;
    }
    proof.call = true;
    const body = await res.json().catch(() => null);
    const tokens = body?.usage?.total_tokens;
    ok(`governed call ok — demo/${body?.model ?? "demo-1"}${tokens ? `, ${tokens} tokens` : ""}`);

    // Absent only when the deployment predates receipts; the id is the handle
    // for the audit row either way.
    const receiptId = res.headers.get("x-passcontrol-receipt-id");
    // No control key (doctor can run without one): the call is still proven,
    // the receipt just cannot be fetched to check.
    if (!receiptId || !apiKey) {
      proof.receipt = "unavailable";
      return proof;
    }
    proof.receiptId = receiptId;

    const row = await fetchReceiptRow(origin, apiKey, receiptId, fetchImpl, wait);
    const jws = row?.receipt;
    if (!jws) {
      // The route says why itself: no INSTANCE_SIGNING_KEY is a configuration
      // answer, not missing data.
      proof.receipt = "unavailable";
      step(
        row?.reason === "receipts_not_enabled"
          ? "This deployment signs no receipts yet (no instance signing key)."
          : "No receipt was stored for that call."
      );
      return proof;
    }

    // Verified HERE, on this machine, against the issuer's published key — the
    // same code path `passcontrol verify receipt` runs for a stranger. If this
    // said "verified" without checking, the feature would be a slogan.
    const verified = await verifyReceipt(jws, { issuer: origin, fetch: fetchImpl });
    proof.receipt = verified.ok ? "verified" : "unverified";
    if (verified.ok) {
      ok(`receipt verified against ${origin}/.well-known/jwks.json`);
      step("");
      step("Your agent is live. Anyone can check that call for themselves:");
      step(`  passcontrol verify receipt ${jws} --issuer ${origin}`);
    } else {
      warn(`A receipt came back but did not verify (${verified.reason}).`);
    }
    return proof;
  } catch (error) {
    // Deliberately quiet. The login worked; this did not, and saying so loudly
    // would teach the operator to distrust a config that is perfectly good.
    proof.reason = error?.message ?? "unknown";
    step("Could not run the first call just now — your config is written and valid.");
    step('Try it yourself:  passcontrol call "hi"');
    return proof;
  }
}
