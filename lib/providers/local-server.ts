// Asking a local OpenAI-compatible server which models it has.
//
// Used by the dashboard, never by the gateway: Settings' "Use Ollama" setup
// checks that Ollama is answering before it stores anything, and the agent
// wizard offers the installed models instead of a blank text box.
//
// The dashboard fetching an address the developer chose is the same question
// the gateway answers with the operator gate, so it answers to that gate too:
// the address goes through `normalizeEndpointFor("local", …)` first, and where
// the gate is off (hosted Cloud) nothing is sent at all. No credential is sent:
// the servers this is for take none, and decrypting a key to list models would
// put a provider secret in the dashboard for a convenience.
import { clientModelIsUsable } from "@/lib/agent-connect";
import { joinUpstream, normalizeEndpointFor, type EndpointPolicy } from "@/lib/providers/endpoint";

/** Ollama's OpenAI-compatible base on this machine, as its own docs give it. */
export const OLLAMA_ENDPOINT = "http://localhost:11434/v1";

/** As many as a chooser can usefully show; a server with more is still usable by typing. */
export const LOCAL_MODEL_LIST_MAX = 50;

/** Short: a local server answers in milliseconds or is not running. */
const PROBE_TIMEOUT_MS = 2_000;

export type LocalModelList =
  | { state: "ok"; models: string[] }
  /** The gate does not admit this address, so nothing was sent. */
  | { state: "disabled" }
  /** Nothing answered, or what answered was not a model listing. */
  | { state: "unreachable" }
  /** The server answered with an error (a key it needs, a redirect). */
  | { state: "refused"; status: number };

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export async function listLocalModels(
  endpoint: string,
  policy: EndpointPolicy,
  fetchImpl: FetchLike = fetch
): Promise<LocalModelList> {
  const base = normalizeEndpointFor("local", endpoint, policy);
  if (!base) return { state: "disabled" };

  let res: Response;
  try {
    res = await fetchImpl(joinUpstream(base, ["models"]), {
      method: "GET",
      // A redirect would take this request somewhere the gate never saw.
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    return { state: "unreachable" };
  }
  if (res.status < 200 || res.status >= 300) return { state: "refused", status: res.status };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { state: "unreachable" };
  }
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return { state: "unreachable" };

  const models: string[] = [];
  for (const entry of data) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !clientModelIsUsable(id) || models.includes(id)) continue;
    models.push(id);
    if (models.length === LOCAL_MODEL_LIST_MAX) break;
  }
  return { state: "ok", models };
}
