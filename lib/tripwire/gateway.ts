// Hosted decoy handling is absent in Core. Ordinary authentication still decides.
export async function tripwireForUncredentialed(..._args: unknown[]): Promise<Response | null> { return null; }
export async function tripwireForUnknownDirectKey(..._args: unknown[]): Promise<Response | null> { return null; }
// Keep the shared authentication signature. Core never resolves the lazy presenter,
// so sender proof and its nonce remain for the route's normal authentication check.
type Presenter = { kind: "agent"; userId: string; agentId: string } | { kind: "unauthenticated" };
export async function tripwireForSecondaryCredentials(
  _req: Request,
  _db: unknown,
  _principal: { userId: string; agentId: string } | (() => Promise<Presenter>),
  _primary: string,
  _route: string,
): Promise<Response | null> { return null; }
export function scheduleTripwireSeen(..._args: unknown[]): void {}
