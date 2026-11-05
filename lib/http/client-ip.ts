type HeaderReader = { get(name: string): string | null };

interface ProxyEnvironment {
  PASSCONTROL_TRUST_CF_CONNECTING_IP?: string;
  VERCEL?: string;
}

/** Trust provider IP headers only when this deployment explicitly opts in. */
export function clientIpFrom(
  incoming: HeaderReader,
  environment: ProxyEnvironment = {
    PASSCONTROL_TRUST_CF_CONNECTING_IP: process.env.PASSCONTROL_TRUST_CF_CONNECTING_IP,
    VERCEL: process.env.VERCEL,
  }
): string {
  const cloudflareIp = environment.PASSCONTROL_TRUST_CF_CONNECTING_IP === "true"
    ? incoming.get("cf-connecting-ip")?.trim()
    : undefined;
  const vercelIp = environment.VERCEL === "1"
    ? incoming.get("x-vercel-forwarded-for")?.split(",")[0]?.trim()
    : undefined;
  return (
    cloudflareIp ||
    vercelIp ||
    incoming.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    incoming.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

export function clientIp(req: Request): string {
  return clientIpFrom(req.headers);
}
