// The local stack's addresses as a function of the port offset `setup` was
// given. One definition for setup and everything that reads its result, so a
// second install (`setup --port-offset N`) moves as a whole: Supabase, Redis
// (scripts/dev-stack.sh) and the dashboard.

/** The canonical local dashboard port, used when no offset was given. */
export const LOCAL_DASHBOARD_PORT = 3000;

/** The same bounds setup enforces on --port-offset. */
function assertOffset(offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset > 10000) {
    throw new Error("--port-offset must be an integer from 0 to 10000.");
  }
}

/** The local dashboard origin for a stack set up with this port offset. */
export function dashboardOriginForOffset(offset) {
  assertOffset(offset);
  return `http://localhost:${LOCAL_DASHBOARD_PORT + offset}`;
}

// Supabase names each container supabase_<service>_<project>. Services with an
// underscore come first, so "supabase_edge_runtime_x" is not read as project
// "runtime_x".
const SUPABASE_SERVICES = [
  "edge_runtime", "pg_meta", "db", "kong", "inbucket", "mailpit", "analytics",
  "studio", "rest", "auth", "realtime", "storage", "imgproxy", "vector", "pooler",
];

/** The Supabase project a container belongs to, or null when it is not a Supabase service. */
export function stackProjectFromContainer(name) {
  for (const service of SUPABASE_SERVICES) {
    const prefix = `supabase_${service}_`;
    if (name.startsWith(prefix) && name.length > prefix.length) return name.slice(prefix.length);
  }
  return null;
}

/**
 * Which running containers publish which of `ports`, from
 * `docker ps --format '{{.Names}}\t{{.Ports}}'`. A port held by something that
 * is not a container (a database installed natively, say) is simply absent.
 */
export function portHolders(psOutput, ports) {
  const holders = [];
  for (const line of String(psOutput).split("\n")) {
    const [rawName, published = ""] = line.split("\t");
    const container = rawName?.trim();
    if (!container) continue;
    const held = ports.filter((port) => new RegExp(`:${port}->`, "u").test(published));
    if (held.length) holders.push({ container, project: stackProjectFromContainer(container), ports: held });
  }
  return holders;
}

/** The refusal for busy stack ports: who holds them, and the exact command that frees them. */
export function stackPortConflictMessage({ busy, holders = [], rerun }) {
  const projects = [...new Set(holders.map((holder) => holder.project).filter(Boolean))];
  const containers = holders.filter((holder) => !holder.project).map((holder) => holder.container);
  const owners = [];
  if (projects.length) {
    owners.push(`another local Supabase stack (project ${projects.map((project) => `"${project}"`).join(", ")})`);
  }
  if (containers.length) owners.push(`container ${containers.join(", ")}`);
  const ports = `Local stack ports ${busy.join(", ")} are in use by ${owners.length ? owners.join(" and ") : "another program or project"}.`;
  // `docker stop` keeps a container and its volume, like `supabase stop`.
  const commands = [
    ...projects.map((project) => `\`supabase stop --project-id ${project}\``),
    ...containers.map((container) => `\`docker stop ${container}\``),
  ];
  const fix = commands.length
    ? `Stop ${commands.length > 1 ? "them" : "it"} first (data is kept): ${commands.join(" and ")}`
    : "Stop that project first (for example, `supabase stop --project-id <project>`)";
  return `${ports} ${fix}, then rerun \`${rerun}\`.`;
}
