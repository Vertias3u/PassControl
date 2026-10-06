// The dashboard's server actions, as components should call them.
//
// app/dashboard/actions.ts RETURNS each outcome (a thrown message does not
// survive a production build). This module re-throws a failure on the CLIENT,
// where the message does survive, so a component keeps writing
// `try { await revokeApiKey(id) } catch (e) { show(e.message) }` exactly as
// before. Calling the server module directly would hand back a result object
// that is easy to ignore, and an ignored failure reads as success; on revoke,
// suspend or the kill switch that is a false success on a security control.
// tests/action-result.test.ts refuses any component that tries.
import * as actions from "./actions";
import { unwrap, type ActionResult } from "@/lib/action-result";

function client<A extends unknown[], T>(
  action: (...args: A) => Promise<ActionResult<T>>
): (...args: A) => Promise<T> {
  return async (...args: A) => unwrap(await action(...args));
}

export const setMasterKill = client(actions.setMasterKill);
export const observeMasterKill = client(actions.observeMasterKill);
export const setAgentSuspended = client(actions.setAgentSuspended);
export const observeAgentControl = client(actions.observeAgentControl);
export const createAgent = client(actions.createAgent);
export const issueDirectAgent = client(actions.issueDirectAgent);
export const issueDirectAgentKey = client(actions.issueDirectAgentKey);
export const revokeDirectAgentKey = client(actions.revokeDirectAgentKey);
export const attachAgentPassport = client(actions.attachAgentPassport);
export const updateAgentBudgets = client(actions.updateAgentBudgets);
export const updateAgentScopes = client(actions.updateAgentScopes);
export const updateAgentFallbacks = client(actions.updateAgentFallbacks);
export const addProviderKey = client(actions.addProviderKey);
export const probeProviderKey = client(actions.probeProviderKey);
export const completeKeyImport = client(actions.completeKeyImport);
export const completeKeyImportDirect = client(actions.completeKeyImportDirect);
export const rotateProviderKey = client(actions.rotateProviderKey);
export const setActiveProviderKey = client(actions.setActiveProviderKey);
export const setProviderEndpoint = client(actions.setProviderEndpoint);
export const connectOllama = client(actions.connectOllama);
export const listLocalModelsForAgents = client(actions.listLocalModelsForAgents);
export const deleteProviderKey = client(actions.deleteProviderKey);
export const createApiKey = client(actions.createApiKey);
export const inspectCliDevice = client(actions.inspectCliDevice);
export const approveCliDevice = client(actions.approveCliDevice);
export const denyCliDevice = client(actions.denyCliDevice);
export const revokeApiKey = client(actions.revokeApiKey);
