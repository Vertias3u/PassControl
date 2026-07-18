// Seed a confirmed dev user into the local Supabase stack, so you can log into
// the Control Tower immediately (email confirmation is off locally, but we set
// email_confirm anyway to be explicit). There is NO auto-trigger creating the
// public.users profile — RPCs create it lazily — so we insert it here too.
//
// Reads env (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). dev-stack.sh
// sources .env.docker before calling this; you can also run it standalone with
// those two vars exported.
//
//   node scripts/seed.mjs
//
// Optional: DEV_USER_EMAIL, DEV_USER_PASSWORD (sensible defaults below).
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

// Fixed demo credentials — seeded ONLY when PASSCONTROL_DEMO=1 (local "try it"
// stack). The demo passport has `demo` scope only (reaches the keyless demo
// provider — no real key, no cost); the demo control key drives the kill switch
// in `passcontrol try`. Both are inert in any deployment without the demo
// provider enabled. Keep in sync with bin/passcontrol.mjs.
// App-side source of truth: lib/demo/identity.ts (duplicated here to keep this plain-ESM seed script transpilation-free).
const DEMO_PASSPORT_ID = "kZCFp7d2x4VDruiulJ21gogYbczBDAGZa-OuwR3qgh8";
const DEMO_API_KEY = "pc_demolocaltrydemolocaltrydemolocaltry0000";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.env.DEV_USER_EMAIL ?? "dev@passcontrol.local";
const password = process.env.DEV_USER_PASSWORD ?? "passcontrol-dev";

if (!url || !serviceKey) {
  console.error("seed: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (source .env.docker first).");
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function findUserByEmail(addr) {
  // listUsers is paginated; the local stack is tiny, so one page is plenty.
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  return data.users.find((u) => u.email === addr) ?? null;
}

async function main() {
  console.log(`seed → ${url}`);

  let userId;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) {
    // Already registered from a previous run → reuse it (idempotent seed).
    const existing = await findUserByEmail(email);
    if (!existing) throw created.error;
    userId = existing.id;
    console.log(`• auth user already existed — reusing (${email})`);
  } else {
    userId = created.data.user.id;
    console.log(`• created confirmed auth user (${email})`);
  }

  // Profile row (service role bypasses RLS). RPCs also upsert this, but seed it
  // so the account is fully usable before any RPC runs.
  const { error: profileErr } = await admin
    .from("users")
    .upsert({ id: userId, email }, { onConflict: "id" });
  if (profileErr) throw profileErr;
  console.log("• ensured public.users profile row");

  // Demo passport + control key for `passcontrol try` (local demo stack only).
  if (process.env.PASSCONTROL_DEMO === "1") {
    const { error: agentErr } = await admin.from("agents").upsert(
      {
        user_id: userId,
        name: "demo-agent",
        passport_pubkey: DEMO_PASSPORT_ID,
        status: "active",
        budget_tokens: 200000,
        budget_cents: null,
        allowed_scopes: [{ provider: "demo", models: ["*"] }],
      },
      { onConflict: "passport_pubkey" }
    );
    if (agentErr) throw agentErr;

    const keyHash = createHash("sha256").update(DEMO_API_KEY).digest("hex");
    const { error: keyErr } = await admin.from("api_keys").upsert(
      {
        user_id: userId,
        name: "demo-try-key",
        key_prefix: DEMO_API_KEY.slice(0, 11),
        key_hash: keyHash,
        scope: "write",
      },
      { onConflict: "key_hash" }
    );
    if (keyErr) throw keyErr;
    console.log("• seeded demo passport + demo control key (PASSCONTROL_DEMO=1)");
  }

  console.log("\n✅ Seed complete. Log into the Control Tower:");
  console.log(`   email:    ${email}`);
  console.log(`   password: ${password}`);
  if (process.env.PASSCONTROL_DEMO === "1") {
    console.log("\nTry it in one command (no key, no accounts):");
    console.log("   passcontrol try");
  }
  console.log("\nNext (manual, one-time):");
  console.log("   1. Log in → add your provider key (Anthropic/OpenAI) — it goes into the local Vault.");
  console.log('   2. Issue a passport (copy the private key ONCE) → run: node examples/chat-agent.mjs "hi"');
}

main().catch((e) => {
  console.error("\n✗ seed failed:", e.message);
  process.exit(1);
});
