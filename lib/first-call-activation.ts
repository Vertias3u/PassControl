import { partitionByClass } from "./call-class";
import type { AuthMethod } from "./log";
import { isProvider, type ProviderId } from "./providers";
import { scopeAllows } from "./scope";

export type FirstCallStatus =
  | "ok"
  | "blocked_budget"
  | "blocked_budget_period"
  | "blocked_endpoint"
  | "blocked_killed"
  | "blocked_suspended"
  | "blocked_scope"
  | "blocked_policy"
  | "provider_exhausted"
  | "no_provider_key"
  | "endpoint_required"
  | "upstream_error";

export interface FirstCallRow {
  id: string;
  agent_id: string | null;
  provider: string | null;
  model: string | null;
  status: FirstCallStatus | string;
  receipt: string | null;
  auth_method?: AuthMethod | null;
  /** Which installation key made a Direct Agent Key call; null for passports and old rows. */
  agent_access_key_id?: string | null;
  created_at: string;
}

export interface FirstCallAgent {
  id: string;
  name: string;
  status: string;
  identityKind?: "passport" | "direct_key";
  /** The agent's grant, so the guide can name a model it will refuse. */
  scopes?: readonly { provider: string; models: readonly string[] }[];
}

/** The guide's refusal test, as started through start_onboarding_refusal_test (0072). */
export interface RefusalTest {
  agentId: string;
  startedAt: string;
}

/**
 * What the stored row proves about how the call authenticated — and nothing more.
 *
 * The two passport values say different things. `passport` means the request
 * presented a reusable, short-lived HS256 bearer visa; the private key signed a
 * challenge earlier, at mint time, but did not prove possession on this request.
 * `passport_proof_per_request` means the gateway additionally verified a fresh
 * Ed25519 proof bound to this exact visa, method and path and burned its proof
 * jti. A reused or stolen still-valid visa is exactly the case that separates
 * those values, so neither may borrow the other's words.
 *
 * `Passport visa accepted` remains the canonical bearer phrase. The proofed
 * phrase is deliberately stronger and explicitly per-request.
 *
 * The direct branch is deliberately byte-identical to before: a Direct Agent Key
 * is lower-assurance bearer possession and borrows neither passport nor visa
 * wording. The fallback names no credential class at all — a legacy row predates
 * the column, and guessing would manufacture evidence.
 */
export function authenticationProofLabel(authMethod: FirstCallRow["auth_method"]): string {
  if (authMethod === "passport") return "Passport visa accepted";
  if (authMethod === "passport_proof_per_request") {
    return "Passport proof verified per request";
  }
  if (authMethod === "direct_key") return "Direct Agent Key accepted";
  return "Authentication method was not recorded on this older call";
}

export type FirstCallActivation =
  | { stage: "provider" }
  | { stage: "agent" }
  /**
   * `connected` means the gateway has admitted SDK housekeeping from this fleet
   * — a capability probe — without an inference call following it. That is a
   * genuinely different position from silence: the base URL and the credential
   * are already proven right, and only the model call itself is outstanding. It
   * is deliberately NOT a completion (see `admitted` below).
   */
  | { stage: "call"; agentId: string; agentName: string; connected: boolean }
  | { stage: "diagnose"; agentId: string; agentName: string; row: FirstCallRow }
  /**
   * Traffic has passed; the refusal half is outstanding. `test` is null until
   * the operator starts the guide's refusal test, which is what binds a later
   * refusal to a deliberate demonstration. `testModel` is a model this agent's
   * grant refuses, or null when the grant allows everything and there is
   * nothing to refuse until it is narrowed.
   */
  | {
      stage: "refuse";
      agentId: string;
      agentName: string;
      row: FirstCallRow;
      receiptRecorded: boolean;
      test: RefusalTest | null;
      testModel: string | null;
      provider: ProviderId | null;
    }
  /**
   * The browser has seen both halves. NOT a completion by itself: the guide
   * renders "complete" only after complete_onboarding() re-derives the same
   * proof from the authoritative history and says so.
   */
  | {
      stage: "proven";
      agentId: string;
      agentName: string;
      row: FirstCallRow;
      refusal: FirstCallRow;
      receiptRecorded: boolean;
    };

/** The only persisted onboarding fields; no derived step belongs here. */
export interface OnboardingStateRow {
  dismissed_at: string | null;
  completed_at: string | null;
}

/** A durable terminal preference; every non-terminal step is still real state. */
export function onboardingStateHidden(row: OnboardingStateRow | null | undefined): boolean {
  return Boolean(row?.dismissed_at || row?.completed_at);
}

/**
 * Models the guide suggests for the refusal test, per provider — real, well-known
 * ids, so the demonstration reads as "this worker cannot switch to X on its
 * own". The call is refused before dispatch, so none of them is ever sent. If
 * the grant covers every candidate, an obviously synthetic id is used; if the
 * grant covers even that (a bare `*`), there is nothing to refuse.
 */
const REFUSAL_TEST_CANDIDATES: Readonly<Record<ProviderId, readonly string[]>> = {
  openai: ["gpt-5", "gpt-4.1", "o3"],
  anthropic: ["claude-opus-4-1", "claude-sonnet-4-5"],
  groq: ["llama-3.1-8b-instant", "qwen/qwen3-32b"],
  mistral: ["mistral-large-latest", "codestral-latest"],
  together: ["meta-llama/Llama-3.3-70B-Instruct-Turbo"],
  deepseek: ["deepseek-reasoner"],
  gemini: ["gemini-2.5-pro"],
  xai: ["grok-4.7", "grok-4.3"],
  // Azure's `model` is a deployment name the customer chose. These fall outside
  // the default `gpt-*` grant, so the demonstration works on the default scope;
  // a grant that covers them falls through to the synthetic id below.
  azure: ["o3", "o4-mini"],
};
const SYNTHETIC_REFUSAL_MODEL = "passcontrol-refusal-test";

export function refusalTestModel(
  scopes: readonly { provider: string; models: readonly string[] }[],
  provider: ProviderId
): string | null {
  const grant = scopes.map((entry) => ({ provider: entry.provider, models: [...entry.models] }));
  for (const candidate of [...REFUSAL_TEST_CANDIDATES[provider], SYNTHETIC_REFUSAL_MODEL]) {
    if (!scopeAllows(grant, provider, candidate)) return candidate;
  }
  return null;
}

function time(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** Both rows from one installation key, when both say which key. Mirrors 0072. */
function sameInstallation(allowed: FirstCallRow, refused: FirstCallRow): boolean {
  return !allowed.agent_access_key_id || !refused.agent_access_key_id
    || allowed.agent_access_key_id === refused.agent_access_key_id;
}

/**
 * The refusal that proves the test, and the allowed call it pairs with — the
 * browser's copy of complete_onboarding()'s rule. Same agent; `blocked_scope`
 * with a model; at or after the test started; after an `ok` inference; same
 * installation key when both rows carry one.
 */
function findRefusalProof(
  inference: readonly FirstCallRow[],
  test: RefusalTest
): { allowed: FirstCallRow; refusal: FirstCallRow } | null {
  const started = time(test.startedAt);
  if (!Number.isFinite(started)) return null;
  for (const refusal of inference) {
    if (refusal.agent_id !== test.agentId || refusal.status !== "blocked_scope" || !refusal.model?.trim()) continue;
    const refusedAt = time(refusal.created_at);
    if (!(refusedAt >= started)) continue;
    const allowed = inference.find((row) =>
      row.agent_id === test.agentId
      && row.status === "ok"
      && Boolean(row.model?.trim())
      && time(row.created_at) < refusedAt
      && sameInstallation(row, refusal)
    );
    if (allowed) return { allowed, refusal };
  }
  return null;
}

export function deriveFirstCallActivation(input: {
  providerConfigured: boolean;
  agents: readonly FirstCallAgent[];
  logs: readonly FirstCallRow[];
  /**
   * Required on purpose — no default. A refusal only proves anything relative
   * to a deliberate demonstration, so every call site has to say whether one
   * was started rather than inherit "none" by omission.
   */
  refusalTest: RefusalTest | null;
}): FirstCallActivation {
  if (!input.providerConfigured) return { stage: "provider" };

  // A suspended agent still exists and its refused attempt is the most useful
  // onboarding diagnosis. Only terminally revoked rows stop counting as a
  // usable first identity.
  const activeAgents = input.agents.filter((agent) => agent.status !== "revoked");
  if (activeAgents.length === 0) return { stage: "agent" };

  const byId = new Map(activeAgents.map((agent) => [agent.id, agent]));
  const relevantRows = input.logs.filter((row) => row.agent_id && byId.has(row.agent_id));

  // Housekeeping is preserved in the log and excluded from the milestone.
  //
  // An SDK lists models on startup, which the gateway admits and records as a
  // perfectly ordinary `ok` row. Completing onboarding on that row tells the
  // operator their agent is working when it has not yet run one inference — the
  // handshake proves the wiring, not the work. `classifyCall` fails toward
  // "inference", so a refused probe stays a diagnosable attempt below.
  const { inference, housekeeping } = partitionByClass(relevantRows);

  const admitted = inference.find((row) => row.status === "ok");
  if (admitted?.agent_id) {
    // The worker under test: the one the operator started the test for, when
    // it is still a usable agent that has been admitted in this window;
    // otherwise the one that was admitted most recently.
    const test = input.refusalTest
      && byId.has(input.refusalTest.agentId)
      && inference.some((row) => row.agent_id === input.refusalTest!.agentId && row.status === "ok")
      ? input.refusalTest
      : null;
    const agent = byId.get(test?.agentId ?? admitted.agent_id)!;
    const allowedRow = inference.find((row) => row.agent_id === agent.id && row.status === "ok")!;
    const proof = test ? findRefusalProof(inference, test) : null;
    if (proof) {
      return {
        stage: "proven",
        agentId: agent.id,
        agentName: agent.name,
        row: proof.allowed,
        refusal: proof.refusal,
        receiptRecorded: Boolean(proof.allowed.receipt),
      };
    }
    // One admitted call proves the path is OPEN. The guide ends only when this
    // same worker has also been refused, because refusing is the product.
    const provider = allowedRow.provider && isProvider(allowedRow.provider) ? allowedRow.provider : null;
    return {
      stage: "refuse",
      agentId: agent.id,
      agentName: agent.name,
      row: allowedRow,
      receiptRecorded: Boolean(allowedRow.receipt),
      test,
      testModel: provider ? refusalTestModel(agent.scopes ?? [], provider) : null,
      provider,
    };
  }

  // The newest row the operator can actually act on. A succeeded probe sitting
  // on top of a refusal must not become the diagnosis — there is nothing to fix
  // about a handshake that worked, and the refusal underneath is the real state.
  const attempted = inference[0];
  if (attempted?.agent_id) {
    const agent = byId.get(attempted.agent_id)!;
    return {
      stage: "diagnose",
      agentId: agent.id,
      agentName: agent.name,
      row: attempted,
    };
  }

  // Prefer the agent the SDK actually reached, so the instructions name the
  // identity whose credential is already known to work.
  const probed = housekeeping[0]?.agent_id;
  const agent = (probed ? byId.get(probed) : undefined) ?? activeAgents[0]!;
  return {
    stage: "call",
    agentId: agent.id,
    agentName: agent.name,
    connected: housekeeping.length > 0,
  };
}

export interface ActivationDiagnosis {
  title: string;
  detail: string;
  action: "settings" | "fleet" | "policy" | "activity";
}

export function activationDiagnosis(row: FirstCallRow): ActivationDiagnosis {
  if (row.model?.includes("*")) {
    return {
      title: "Use a concrete model name",
      detail: `${row.model} is an authorization pattern, not a model the provider can call. Replace it with a concrete model covered by that pattern.`,
      action: "policy",
    };
  }

  switch (row.status) {
    case "endpoint_required":
      return {
        title: "Add the key's resource address",
        detail: "The key is stored, but not the address of the resource it belongs to, so PassControl had nowhere to send it. Set the address on that key rather than adding another one.",
        action: "settings",
      };
    case "no_provider_key":
      return {
        title: "Store the provider key",
        detail: "PassControl had no credential to inject, so the call stopped before reaching the provider.",
        action: "settings",
      };
    case "blocked_scope":
      return {
        title: "Model outside this agent's scope",
        detail: "The stored capability does not cover this provider and model. Review the agent's allowed model patterns.",
        action: "policy",
      };
    case "blocked_policy":
      return {
        title: "Live policy refused the call",
        detail: "The request reached PassControl, but the agent's current live policy denied it.",
        action: "policy",
      };
    case "blocked_budget":
      return {
        title: "PassControl budget refused the call",
        detail: "The request stopped before provider dispatch because this agent did not have enough remaining PassControl budget.",
        action: "fleet",
      };
    case "blocked_budget_period":
      return {
        title: "The daily or monthly limit refused the call",
        detail: "The request stopped before provider dispatch because this agent has used its spend limit for the current UTC period. It clears at the next period boundary.",
        action: "fleet",
      };
    case "provider_exhausted":
      return {
        title: "Provider credit is exhausted",
        detail: "PassControl allowed and forwarded the call, but the provider account reported insufficient credit.",
        action: "settings",
      };
    case "blocked_killed":
      return {
        title: "Kill switch blocked the call",
        detail: "A platform or workspace kill state is armed. Clear it only if traffic should resume.",
        action: "fleet",
      };
    case "blocked_suspended":
      return {
        title: "Agent is suspended",
        detail: "This agent was suspended when PassControl recorded the attempt.",
        action: "fleet",
      };
    case "blocked_endpoint":
      return {
        title: "Base URL or endpoint is wrong",
        detail: "The request used a provider path that PassControl does not admit. Copy the provider-native configuration again.",
        action: "activity",
      };
    case "upstream_error":
      return {
        title: "Provider rejected or could not complete the call",
        detail: "PassControl dispatched the request. Check the provider key, concrete model name, account access and provider availability.",
        action: "settings",
      };
    default:
      return {
        title: "The call did not clear the gate",
        detail: "Open the stored call record for its exact status before changing the agent or provider configuration.",
        action: "activity",
      };
  }
}
