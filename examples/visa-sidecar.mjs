// PassControl VISA SIDECAR — make PassControl drop-in for ANY agent that expects a
// static API key (OpenHands, Aider, Cline, Continue, …), not just ones using our SDK.
//
// It's a tiny local reverse proxy: it holds your passport, mints + refreshes a
// work-visa in the background, and injects it into every request it forwards to the
// gateway — stripping whatever placeholder key the agent sent. To the agent it looks
// like a normal LLM endpoint with a never-expiring key; the real key never leaves the
// gateway's vault and the visa is refreshed for you.
//
// Run:
//   cp .passcontrol.example .passcontrol   # fill PASSPORT_ID/PASSPORT_SECRET
//   node examples/visa-sidecar.mjs
//   (or: npm run sidecar)
//
// Then point your agent at the sidecar EXACTLY as you'd point it at the gateway,
// e.g. base URL http://localhost:8788/api/v1/anthropic  (or .../api/v1/openai),
// API key = anything (it's ignored/replaced). The sidecar forwards the same path to
// the gateway with a fresh visa.
//
// Env: PASSCONTROL_GATEWAY (default http://localhost:3000) · SIDECAR_PORT (8788) ·
//      REFRESH_SKEW_SECONDS (30) · SIDECAR_HOST (127.0.0.1).
import { config, requirePassport } from "./_config.mjs";
import { startSidecar } from "../cli/sidecar.mjs";

const GATEWAY = config.gateway;
const PORT = Number(process.env.SIDECAR_PORT ?? 8788);
const HOST = process.env.SIDECAR_HOST ?? "127.0.0.1";
const REFRESH_SKEW_SECONDS = Number(process.env.REFRESH_SKEW_SECONDS ?? 30);
const { passportId: PASSPORT_ID, passportSecret: PASSPORT_SECRET } = requirePassport();

startSidecar({
  gateway: GATEWAY,
  passportId: PASSPORT_ID,
  passportSecret: PASSPORT_SECRET,
  port: PORT,
  host: HOST,
  refreshSkewSeconds: REFRESH_SKEW_SECONDS,
});
