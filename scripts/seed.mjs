// Seed the Control Tower account into the local Supabase stack, so you can log in
// immediately (email confirmation is off locally, but we set email_confirm anyway
// to be explicit). There is NO auto-trigger creating the public.users profile —
// RPCs create it lazily — so we insert it here too.
//
// The account password is CHOSEN BY YOU on first boot, never a shared default: the
// local stack guards real provider keys in the Vault, and it stops being
// localhost-only the moment you reach it over a tailnet or LAN from a phone.
// Non-interactive runs (CI, piped output) get a generated password printed once.
//
// Reads env (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). dev-stack.sh
// sources .env.docker before calling this; you can also run it standalone with
// those two vars exported.
//
//   node scripts/seed.mjs
//
// Optional: DEV_USER_EMAIL, DEV_USER_PASSWORD (skip the prompts — for CI).
import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

// Fixed demo credentials — seeded ONLY when PASSCONTROL_DEMO=1 (local "try it"
// stack). The demo passport has `demo` scope only (reaches the keyless demo
// provider — no real key, no cost); the demo control key drives the kill switch
// in `passcontrol try`. Both are inert in any deployment without the demo
// provider enabled. These are public by design and are NOT account credentials.
// Keep in sync with bin/passcontrol.mjs.
// App-side source of truth: lib/demo/identity.ts (duplicated here to keep this plain-ESM seed script transpilation-free).
const DEMO_PASSPORT_ID = "kZCFp7d2x4VDruiulJ21gogYbczBDAGZa-OuwR3qgh8";
const DEMO_API_KEY = "pc_demolocaltrydemolocaltrydemolocaltry0000";

const DEFAULT_EMAIL = "admin@passcontrol.local";

/** Short enough not to annoy on a local stack, long enough not to be guessable. */
export const MIN_PASSWORD_LENGTH = 12;

export function generatePassword() {
  return randomBytes(18).toString("base64url");
}

/**
 * Decide the password for a NEW account. Three sources, in order:
 *   env      — DEV_USER_PASSWORD, for CI and scripted installs
 *   prompt   — the operator chooses one (the normal first-boot path)
 *   generated — no terminal to ask on; generate and print it once
 * There is deliberately no shared default: every install must end up with a
 * distinct secret.
 */
export async function resolveNewPassword(env = {}, opts = {}) {
  const { interactive = false, ask } = opts;

  const supplied = env.DEV_USER_PASSWORD;
  if (supplied) {
    if (supplied.length < MIN_PASSWORD_LENGTH) {
      throw new Error(
        `DEV_USER_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`
      );
    }
    return { password: supplied, source: "env" };
  }

  if (interactive && ask) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const answer =
        (await ask(`Choose a Control Tower password (min ${MIN_PASSWORD_LENGTH} chars): `)) ?? "";
      if (answer.length >= MIN_PASSWORD_LENGTH) {
        return { password: answer, source: "prompt" };
      }
      console.error(`  ✗ too short — at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    throw new Error("No acceptable password provided.");
  }

  return { password: generatePassword(), source: "generated" };
}

// ── Terminal prompts (only used when a TTY is attached) ───────────────────────
async function askVisible(question) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Same as askVisible but does not echo — the answer would otherwise sit in scrollback. */
async function askHidden(question) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const output = rl.output;
  let muted = false;
  const write = output.write.bind(output);
  output.write = (chunk, ...rest) => (muted ? true : write(chunk, ...rest));
  try {
    const pending = rl.question(question);
    muted = true;
    const answer = await pending;
    return answer.trim();
  } finally {
    muted = false;
    output.write = write;
    process.stdout.write("\n");
    rl.close();
  }
}

async function findUserByEmail(admin, addr) {
  // listUsers is paginated; the local stack is tiny, so one page is plenty.
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  return data.users.find((u) => u.email === addr) ?? null;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error(
      "seed: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (source .env.docker first)."
    );
    process.exit(1);
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  console.log(`seed → ${url}`);

  // Email is not a secret, so a default is fine — but offer to change it when
  // there is someone to ask.
  let email = process.env.DEV_USER_EMAIL;
  if (!email && interactive) {
    console.log("\nSet up your Control Tower account (this guards your provider keys).");
    email = await askVisible(`Email [${DEFAULT_EMAIL}]: `);
  }
  email = email || DEFAULT_EMAIL;

  let userId;
  let generatedPassword = null;
  const existing = await findUserByEmail(admin, email);

  if (existing) {
    // Idempotent re-run: keep the account (and its password) exactly as it is.
    userId = existing.id;
    console.log(`• account already exists — reusing (${email})`);
  } else {
    const { password, source } = await resolveNewPassword(process.env, {
      interactive,
      ask: askHidden,
    });
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (created.error) throw created.error;
    userId = created.data.user.id;
    if (source === "generated") generatedPassword = password;
    console.log(`• created confirmed account (${email})`);
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
  if (generatedPassword) {
    console.log(`   password: ${generatedPassword}`);
    console.log("   ↑ generated because no terminal was attached — save it now, it is not stored.");
  } else {
    console.log("   password: the one you chose");
  }
  if (process.env.PASSCONTROL_DEMO === "1") {
    console.log("\nTry it in one command (no key, no accounts):");
    console.log("   passcontrol try");
  }
  console.log("\nNext (manual, one-time):");
  console.log("   1. Log in → add your provider key (Anthropic/OpenAI) — it goes into the local Vault.");
  console.log('   2. Issue a passport (copy the private key ONCE) → run: node examples/chat-agent.mjs "hi"');
}

// Only run when invoked directly, so the helpers above stay importable by tests.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error("\n✗ seed failed:", e.message);
    process.exit(1);
  });
}
