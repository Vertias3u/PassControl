// PassControl control-plane SDK — a typed client for the developer API
// (/api/control/v1), authenticated with a `pc_` API key. Mirrors the REST
// resources 1:1. Distinct from the data-plane client in ./passcontrol (visa
// minting for agents); this manages the fleet.
//
//   import { ControlClient } from "passcontrol/control";
//   const pc = new ControlClient({ gateway, apiKey: process.env.PC_API_KEY! });
//   const agents = await pc.agents.list({ status: "active" });
//
// Responses are unwrapped (the API's `{ data }` envelope → the value); non-2xx
// throws ControlApiError carrying the API error code + request id.

export interface ControlClientOptions {
  /** Gateway origin, e.g. https://gateway.example.com (no trailing slash). */
  gateway: string;
  /** Developer API key (`pc_…`). Keep server-side. */
  apiKey: string;
  /** Override the transport (tests / custom fetch). Defaults to global fetch. */
  fetch?: typeof fetch;
}

export class ControlApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string
  ) {
    super(message);
    this.name = "ControlApiError";
  }
}

export interface WriteOpts {
  /** Idempotency-Key — a retry with the same key won't re-apply the mutation. */
  idempotencyKey?: string;
}

type Query = Record<string, string | number | undefined>;

export class ControlClient {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly transport: typeof fetch;

  constructor(opts: ControlClientOptions) {
    if (!opts.gateway || !opts.apiKey) throw new Error("ControlClient: gateway and apiKey are required.");
    this.base = opts.gateway.replace(/\/+$/, "") + "/api/control/v1";
    this.apiKey = opts.apiKey;
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new Error("ControlClient: no fetch available; pass options.fetch.");
    this.transport = (...a: Parameters<typeof fetch>) => f(...a);
  }

  private async req<T = unknown>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown; idempotencyKey?: string } = {}
  ): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}` };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;

    const res = await this.transport(url.toString(), {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const e = (json?.error ?? {}) as { code?: string; message?: string; request_id?: string };
      throw new ControlApiError(res.status, e.code ?? "error", e.message ?? res.statusText, e.request_id);
    }
    return json.data as T;
  }

  readonly agents = {
    list: (params?: { status?: string; limit?: number }) =>
      this.req<any[]>("GET", "/agents", { query: params }),
    get: (id: string) => this.req<any>("GET", `/agents/${encodeURIComponent(id)}`),
    create: (
      body: { name: string; passportPubkey: string; scopes: { provider: string; models: string[] }[]; budget_tokens?: number | null; budget_cents?: number | null },
      opts?: WriteOpts
    ) => this.req<{ id: string; name: string }>("POST", "/agents", { body, idempotencyKey: opts?.idempotencyKey }),
    update: (
      id: string,
      patch: { name?: string; scopes?: { provider: string; models: string[] }[]; budget_tokens?: number | null; budget_cents?: number | null },
      opts?: WriteOpts
    ) => this.req<{ id: string }>("PATCH", `/agents/${encodeURIComponent(id)}`, { body: patch, idempotencyKey: opts?.idempotencyKey }),
    suspend: (id: string, opts?: WriteOpts) =>
      this.req<{ id: string; status: string }>("POST", `/agents/${encodeURIComponent(id)}/suspend`, { idempotencyKey: opts?.idempotencyKey }),
    resume: (id: string, opts?: WriteOpts) =>
      this.req<{ id: string; status: string }>("POST", `/agents/${encodeURIComponent(id)}/resume`, { idempotencyKey: opts?.idempotencyKey }),
    revoke: (id: string, opts?: WriteOpts) =>
      this.req<{ id: string; status: string }>("DELETE", `/agents/${encodeURIComponent(id)}`, { idempotencyKey: opts?.idempotencyKey }),
  };

  readonly logs = {
    list: (params?: { agent_id?: string; status?: string; limit?: number }) =>
      this.req<any[]>("GET", "/logs", { query: params }),
  };

  readonly audit = {
    list: (params?: { limit?: number }) => this.req<any[]>("GET", "/audit", { query: params }),
  };

  readonly spend = {
    get: () => this.req<{ fleet: { spent_tokens: number; spent_microcents: number }; agents: any[] }>("GET", "/spend"),
  };

  readonly killSwitch = {
    get: () => this.req<{ armed: boolean; platform_kill: boolean }>("GET", "/kill-switch"),
    set: (armed: boolean, opts?: WriteOpts) =>
      this.req<{ armed: boolean; affected: number }>("PUT", "/kill-switch", { body: { armed }, idempotencyKey: opts?.idempotencyKey }),
  };
}
