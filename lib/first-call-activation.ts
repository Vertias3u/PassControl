import { partitionByClass } from "./call-class";

export type FirstCallStatus =
  | "ok"
  | "blocked_budget"
  | "blocked_endpoint"
  | "blocked_killed"
  | "blocked_suspended"
  | "blocked_scope"
  | "blocked_policy"
  | "provider_exhausted"
  | "no_provider_key"
  | "upstream_error";

export interface FirstCallRow {
  id: string;
  agent_id: string | null;
  provider: string | null;
  model: string | null;
  status: FirstCallStatus | string;
  receipt: string | null;
  auth_method?: "passport" | "direct_key" | null;
  created_at: string;
}

export interface FirstCallAgent {
  id: string;
  name: string;
  status: string;
  identityKind?: "passport" | "direct_key";
}

/**
 * What the stored row proves about how the call authenticated — and nothing more.
 *
 * The passport branch says **visa**, not signature, and the distinction is the
 * whole point. A passport-mode provider call carries no fresh Ed25519 signature:
 * it presents a reusable, short-lived HS256 bearer visa and `verifyVisa` is the
 * entire check (`app/api/v1/[provider]/[...path]/route.ts`). The private key
 * signed a *challenge* earlier, at mint time, in `app/api/auth/challenge/route.ts`
 * — so the row proves the call used a passport-derived visa, which in turn proves
 * an Ed25519 challenge signature was verified at some point before it. It does
 * NOT prove the private key signed this particular provider request. A reused or
 * stolen still-valid visa is exactly the case where "signature accepted" would be
 * false, and this label is read as onboarding's proof of identity.
 *
 * `Passport visa accepted` is the canonical call-level phrase; `ControlGraph.tsx`
 * says "Passport visa" about the same row and the two must not disagree about how
 * strong the evidence is. Reserve "signature" for a surface that is actually about
 * the challenge/mint exchange.
 *
 * The direct branch is deliberately byte-identical to before: a Direct Agent Key
 * is lower-assurance bearer possession and borrows neither passport nor visa
 * wording. The fallback names no credential class at all — a legacy row predates
 * the column, and guessing would manufacture evidence.
 */
export function authenticationProofLabel(authMethod: FirstCallRow["auth_method"]): string {
  if (authMethod === "passport") return "Passport visa accepted";
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
  | {
      stage: "complete";
      agentId: string;
      agentName: string;
      row: FirstCallRow;
      receiptRecorded: boolean;
    };

export function deriveFirstCallActivation(input: {
  providerConfigured: boolean;
  agents: readonly FirstCallAgent[];
  logs: readonly FirstCallRow[];
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
    const agent = byId.get(admitted.agent_id)!;
    return {
      stage: "complete",
      agentId: agent.id,
      agentName: agent.name,
      row: admitted,
      receiptRecorded: Boolean(admitted.receipt),
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
