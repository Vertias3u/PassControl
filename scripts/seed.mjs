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

  console.log("\n✅ Seed complete. Log into the Control Tower:");
  console.log(`   email:    ${email}`);
  console.log(`   password: ${password}`);
  console.log("\nNext (manual, one-time):");
  console.log("   1. Log in → add your provider key (Anthropic/OpenAI) — it goes into the local Vault.");
  console.log('   2. Issue a passport (copy the private key ONCE) → run: node examples/chat-agent.mjs "hi"');
}

main().catch((e) => {
  console.error("\n✗ seed failed:", e.message);
  process.exit(1);
});
