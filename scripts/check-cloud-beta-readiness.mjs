#!/usr/bin/env node

const ACK_FLAGS = {
  backup: "--ack-backup",
  backupRisk: "--ack-no-backup-risk",
  supabaseAuth: "--ack-supabase-auth",
  smtp: "--ack-smtp",
  advisors: "--ack-advisors",
  rollback: "--ack-rollback",
  betaAuthHook: "--ack-beta-auth-hook",
};

const ACK_MESSAGES = {
  supabaseAuth: "Supabase Auth: production Site URL, callback, confirmation, and recovery have not been acknowledged",
  smtp: "SMTP: custom SMTP delivery has not been tested and acknowledged",
  advisors: "Supabase advisors: security and performance advisor review has not been acknowledged",
  rollback: "rollback: application-first rollback procedure has not been reviewed and acknowledged",
  betaAuthHook: "Supabase Auth: the Before User Created beta-invite hook and direct-signup rejection have not been acknowledged",
};

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function placeholder(value) {
  return !present(value) || /(?:YOUR[-_ ]|replace[-_ ]?with|replace[-_ ]?me|change[-_ ]?me|\.\.\.)/i.test(value);
}

function validHttpsUrl(value, { bareOrigin = false } = {}) {
  if (!present(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && Boolean(url.hostname)
      && (!bareOrigin || (url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password));
  } catch {
    return false;
  }
}

function decodedLength(value, encoding) {
  if (!present(value)) return -1;
  try {
    const bytes = Buffer.from(value, encoding);
    const canonical = encoding === "base64url" ? bytes.toString("base64url") : bytes.toString("base64");
    return canonical.replace(/=+$/u, "") === value.trim().replace(/=+$/u, "") ? bytes.length : -1;
  } catch {
    return -1;
  }
}

function positiveInteger(value) {
  return typeof value === "string" && /^[1-9]\d*$/u.test(value) ? Number(value) : null;
}

export function checkCloudBetaReadiness(env, acknowledgements = {}) {
  const problems = [];
  const requireSecret = (name, minimum = 20) => {
    const value = env[name];
    if (placeholder(value) || value.trim().length < minimum) {
      problems.push(`${name}: missing, placeholder, or shorter than ${minimum} characters`);
    }
  };

  if (!validHttpsUrl(env.NEXT_PUBLIC_SUPABASE_URL) || placeholder(env.NEXT_PUBLIC_SUPABASE_URL)) {
    problems.push("NEXT_PUBLIC_SUPABASE_URL: must be a non-placeholder HTTPS URL");
  }
  requireSecret("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  requireSecret("SUPABASE_SERVICE_ROLE_KEY");
  requireSecret("VISA_SECRET", 32);
  if (decodedLength(env.INSTANCE_SIGNING_KEY, "base64url") !== 32) {
    problems.push("INSTANCE_SIGNING_KEY: must be a base64url-encoded 32-byte Ed25519 seed");
  }
  if (!validHttpsUrl(env.PASSCONTROL_ISSUER, { bareOrigin: true }) || placeholder(env.PASSCONTROL_ISSUER)) {
    problems.push("PASSCONTROL_ISSUER: must be the non-placeholder bare HTTPS production origin");
  }
  if (decodedLength(env.CACHE_ENC_KEY, "base64") !== 32) {
    problems.push("CACHE_ENC_KEY: must be a base64-encoded 32-byte key");
  }
  if (!validHttpsUrl(env.UPSTASH_REDIS_REST_URL) || placeholder(env.UPSTASH_REDIS_REST_URL)) {
    problems.push("UPSTASH_REDIS_REST_URL: must be a non-placeholder HTTPS URL");
  }
  requireSecret("UPSTASH_REDIS_REST_TOKEN");
  requireSecret("CRON_SECRET", 32);

  if (env.PASSCONTROL_SIGNUP_MODE !== "invite") {
    problems.push("PASSCONTROL_SIGNUP_MODE: invite beta requires the exact value invite");
  }
  if (env.PASSCONTROL_INVITE_SOURCE !== "database") {
    problems.push("PASSCONTROL_INVITE_SOURCE: external invite beta requires the exact value database after migration 0025");
  }
  if (!present(env.PASSCONTROL_BETA_OPERATOR_EMAILS) || !env.PASSCONTROL_BETA_OPERATOR_EMAILS.split(",").every((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim()))) {
    problems.push("PASSCONTROL_BETA_OPERATOR_EMAILS: must contain one or more comma-separated operator emails");
  }
  requireSecret("RESEND_API_KEY", 20);
  if (!present(env.PASSCONTROL_BETA_FROM_EMAIL) || !/<[^\s@]+@[^\s@]+\.[^\s@]+>$/u.test(env.PASSCONTROL_BETA_FROM_EMAIL.trim())) {
    problems.push("PASSCONTROL_BETA_FROM_EMAIL: must use the form Display Name <sender@example.com>");
  }

  const directLimit = positiveInteger(env.DIRECT_KEY_IP_LIMIT);
  const directWindow = positiveInteger(env.DIRECT_KEY_IP_WINDOW_S);
  const workspaceLimit = positiveInteger(env.CLOUD_BETA_WORKSPACE_CALL_LIMIT);
  const globalLimit = positiveInteger(env.CLOUD_BETA_GLOBAL_CALL_LIMIT);
  if (!directLimit) problems.push("DIRECT_KEY_IP_LIMIT: must be a positive integer for pre-auth database protection");
  if (!directWindow) problems.push("DIRECT_KEY_IP_WINDOW_S: must be a positive integer");
  if (!workspaceLimit) problems.push("CLOUD_BETA_WORKSPACE_CALL_LIMIT: must be a positive integer");
  if (!globalLimit || (workspaceLimit && globalLimit < workspaceLimit)) {
    problems.push("CLOUD_BETA_GLOBAL_CALL_LIMIT: must be a positive integer at least as large as the workspace limit");
  }

  if (!validHttpsUrl(env.SENTRY_DSN)) {
    problems.push("SENTRY_DSN: required for scrubbed critical agent_log_insert_failed alerts during invite beta");
  }

  if (acknowledgements.backup === true && acknowledgements.backupRisk === true) {
    problems.push("backup: choose exactly one backup acknowledgement");
  } else if (acknowledgements.backup !== true && acknowledgements.backupRisk !== true) {
    problems.push("backup: neither a restore-tested backup nor the explicit free-tier no-backup risk has been acknowledged");
  }

  for (const [name, message] of Object.entries(ACK_MESSAGES)) {
    if (acknowledgements[name] !== true) problems.push(message);
  }
  return problems;
}

function acknowledgementsFromArgs(args) {
  const supplied = new Set(args);
  return Object.fromEntries(Object.entries(ACK_FLAGS).map(([name, flag]) => [name, supplied.has(flag)]));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = checkCloudBetaReadiness(process.env, acknowledgementsFromArgs(process.argv.slice(2)));
  if (problems.length) {
    console.error(problems.map((problem) => `✗ ${problem}`).join("\n"));
    console.error(
      `\nRequired acknowledgements: (${ACK_FLAGS.backup} or ${ACK_FLAGS.backupRisk}) ${ACK_FLAGS.supabaseAuth} ${ACK_FLAGS.smtp} ${ACK_FLAGS.advisors} ${ACK_FLAGS.rollback} ${ACK_FLAGS.betaAuthHook}`
    );
    process.exit(1);
  }
  console.log("✓ Cloud invite-beta readiness verified — configuration shape and operator gates are satisfied");
}
