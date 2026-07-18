// POST /api/demo/run — public-site adapter for the real PassControl demo flow.
// It signs a challenge with the server-only demo passport, mints a real visa,
// then invokes the existing keyless demo provider handler in-process. No global
// fetch is used, and the provider/path are constants: this route cannot reach a
// real upstream, provider-key resolver, or Vault path.
export const runtime = "edge";

import { ed25519 } from "@noble/curves/ed25519";
import { POST as challengePost } from "@/app/api/auth/challenge/route";
import { POST as proxyPost } from "@/app/api/v1/[provider]/[...path]/route";
import {
  base64urlToBytes,
  bytesToBase64url,
  jsonToBase64url,
} from "@/lib/encoding";
import { demoPassportSecret } from "@/lib/demo/identity";
import { rateLimit } from "@/lib/ratelimit";
import { clientIp, demoEnabled, demoPassportId, json } from "../_shared";

const RUN_LIMIT = 8;
const RUN_WINDOW_SECONDS = 60;
const MAX_BODY_BYTES = 2 * 1024;
const MAX_PROMPT_CHARS = 500;

interface RunBody {
  prompt?: unknown;
}

function unavailable(status = 503): Response {
  return json(
    { ok: false, blocked: false, response: "demo temporarily unavailable" },
    status
  );
}

async function parseBody(request: Request): Promise<RunBody | null> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return null;
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(raw) as RunBody;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!demoEnabled()) return json({ error: "not_found" }, 404);

  const ip = clientIp(request);
  const limited = await rateLimit(`demo-run:${ip}`, RUN_LIMIT, RUN_WINDOW_SECONDS);
  if (!limited.success) {
    return json(
      { ok: false, blocked: false, response: "rate limited — try again shortly" },
      429,
      { "retry-after": String(RUN_WINDOW_SECONDS) }
    );
  }

  const body = await parseBody(request);
  if (!body) return json({ error: "invalid_request" }, 400);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) {
    return json({ error: "invalid_prompt" }, 400);
  }

  try {
    const passportId = demoPassportId();
    const privateKey = base64urlToBytes(demoPassportSecret());
    if (
      privateKey.length !== 32 ||
      bytesToBase64url(ed25519.getPublicKey(privateKey)) !== passportId
    ) {
      return unavailable();
    }

    const payload = jsonToBase64url({
      passport_id: passportId,
      ts: Date.now(),
      nonce: crypto.randomUUID(),
    });
    const signature = bytesToBase64url(
      ed25519.sign(base64urlToBytes(payload), privateKey)
    );

    const challengeResponse = await challengePost(
      new Request(new URL("/api/auth/challenge", request.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": ip,
        },
        body: JSON.stringify({ payload, signature }),
      })
    );

    if (!challengeResponse.ok) {
      if (challengeResponse.status === 429) {
        return json(
          { ok: false, blocked: false, response: "rate limited — try again shortly" },
          429,
          { "retry-after": challengeResponse.headers.get("retry-after") || "60" }
        );
      }
      return unavailable();
    }

    const challenge = (await challengeResponse.json()) as { visa?: unknown };
    if (typeof challenge.visa !== "string" || !challenge.visa) return unavailable();

    const proxyResponse = await proxyPost(
      new Request(new URL("/api/v1/demo/chat/completions", request.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${challenge.visa}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "demo-1",
          max_tokens: 64,
          messages: [{ role: "user", content: prompt }],
        }),
      }),
      {
        params: Promise.resolve({ provider: "demo", path: ["chat", "completions"] }),
      }
    );

    const proxyBody = (await proxyResponse.json().catch(() => null)) as {
      error?: unknown;
      choices?: Array<{ message?: { content?: unknown } }>;
    } | null;

    if (proxyResponse.status === 403 && proxyBody?.error === "blocked_suspended") {
      return json({ ok: false, blocked: true, response: "blocked (403)" }, 403);
    }
    if (!proxyResponse.ok) {
      if (proxyResponse.status === 429) {
        return json(
          { ok: false, blocked: false, response: "rate limited — try again shortly" },
          429,
          { "retry-after": proxyResponse.headers.get("retry-after") || "60" }
        );
      }
      return unavailable();
    }

    const responseText = proxyBody?.choices?.[0]?.message?.content;
    if (typeof responseText !== "string") return unavailable(502);
    return json({ ok: true, blocked: false, response: responseText });
  } catch {
    // Public route: return no exception details because credentials and signed
    // material are present in this stack frame.
    return unavailable();
  }
}
