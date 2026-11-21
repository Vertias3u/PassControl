// `passcontrol configure tripwires` — plant, rotate and remove tripwire decoys (idea 12).
//
// A decoy is a Direct Agent Key in every byte (`pc_agent_` + 43 base64url characters from 32
// random bytes), generated HERE, on the owner's machine. The gateway receives only its
// digest and the name of the place it was planted, so the plaintext never crosses the
// network. Planting order: register the digests first, then write the files, so a decoy is
// never on disk without being armed. Rotation registers new digests with `replace` (the old
// ones are retired, and stay armed 30 days) and overwrites only files this tool wrote.
//
// Placement rules, each from a measurement (research/idea-12-tripwire/RESULTS.md, S1/S3):
//   * outside any git repository: GitHub push protection rejects credential-shaped files,
//     and a repo is what agents read most;
//   * never in a file a tool loads by itself (`~/.env` is found by python-dotenv's
//     find_dotenv walking up from a project; `.passcontrol` by this CLI walking up): that
//     would make honest software PRESENT the decoy, a false Used and a false suspension;
//   * in hidden directories (ripgrep skips them by default) and, for the quiet placement,
//     with no keyword at all: honest searches name specific variables, and in 1,103 public
//     interactive sessions none searched for `pc_agent_` or `PASSCONTROL`.
// Never follows a symlink, never overwrites a file it did not write, and keeps a 0600
// manifest of digests (never decoys) for the sidecar's local checks.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PREFIX = "pc_agent_";

/**
 * The placements `configure tripwires` can plant, in default order. The CLI's usage string
 * is generated from this list (CLAUDE.md: never hand-type a list of supported things).
 */
export const TRIPWIRE_PLACEMENTS = {
  // A bare value in a backup-named file under XDG state: found by listing or reading
  // PassControl's state, or by searching for the key shape itself. No keyword to match.
  state_backup: {
    rel: (slug) => `.local/state/passcontrol/agent-key-${slug}.bak`,
    content: (decoy) => `${decoy}\n`,
  },
  // The exact file the dashboard's Setup page gives for a Direct Agent Key: a base URL that
  // is this gateway, and the key. Used as written, it routes the decoy back to PassControl
  // (S5). Not in ~/.config/passcontrol, which honest PassControl debugging reads.
  anthropic_pair: {
    rel: (slug) => `.config/anthropic/credentials-${slug}.env`,
    content: (decoy, origin) => `ANTHROPIC_BASE_URL=${origin}/api/v1/anthropic\nANTHROPIC_API_KEY=${decoy}\n`,
  },
};
export const DEFAULT_TRIPWIRE_PLACEMENTS = ["state_backup", "anthropic_pair"];

export function tripwirePlacementChoices() {
  return Object.keys(TRIPWIRE_PLACEMENTS).join(",");
}

export function generateDecoy() {
  return PREFIX + randomBytes(32).toString("base64url");
}

/** Same digest the gateway's registry and a real Direct Agent Key use. */
export function decoyDigest(decoy) {
  return createHash("sha256").update(decoy, "utf8").digest("base64url");
}

export function tripwireManifestPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "passcontrol", "tripwires.json");
}

export function readTripwireManifest(file = tripwireManifestPath()) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && value.agents && typeof value.agents === "object" ? value : { version: 1, agents: {} };
  } catch {
    return { version: 1, agents: {} };
  }
}

function writeManifest(file, manifest) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Every planted digest on this machine, for the sidecar. */
export function plantedDigests(file = tripwireManifestPath()) {
  const out = new Set();
  for (const agent of Object.values(readTripwireManifest(file).agents)) {
    for (const p of agent?.placements ?? []) if (typeof p?.digest === "string") out.add(p.digest);
  }
  return out;
}

export function slugOf(agentId) {
  return String(agentId).replace(/[^A-Za-z0-9]/g, "").slice(0, 12).toLowerCase() || "agent";
}

/** The git work tree containing `dir`, or null. Walks up looking for `.git`. */
export function enclosingRepo(dir) {
  let at = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(at, ".git"))) return at;
    const parent = path.dirname(at);
    if (parent === at) return null;
    at = parent;
  }
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** Refuses anything unsafe; returns the absolute target. */
export function checkTarget(home, rel, ownDigest) {
  const target = path.resolve(home, rel);
  if (!target.startsWith(path.resolve(home) + path.sep)) throw new Error(`refusing ${rel}: outside the home folder`);
  if (path.basename(target) === ".passcontrol" || path.basename(target) === ".env") {
    throw new Error(`refusing ${rel}: a file name tools load on their own`);
  }
  // Every existing ancestor below home must be a real directory, not a symlink.
  let at = path.resolve(home);
  for (const part of path.relative(home, path.dirname(target)).split(path.sep).filter(Boolean)) {
    at = path.join(at, part);
    const st = lstatOrNull(at);
    if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error(`refusing ${rel}: ${at} is not a plain directory`);
  }
  const existingParent = (() => {
    let p = path.dirname(target);
    while (!fs.existsSync(p)) p = path.dirname(p);
    return p;
  })();
  const repo = enclosingRepo(existingParent);
  if (repo) throw new Error(`refusing ${rel}: inside the git repository ${repo}`);
  const st = lstatOrNull(target);
  if (st) {
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`refusing ${rel}: exists and is not a plain file`);
    const current = fs.readFileSync(target, "utf8");
    const mine = ownDigest && [...current.matchAll(/pc_agent_[A-Za-z0-9_-]{43}/g)].some((m) => decoyDigest(m[0]) === ownDigest);
    if (!mine) throw new Error(`refusing ${rel}: a file is already there that this tool did not write`);
  }
  return target;
}

/**
 * Plan, register, then write. `register(decoys, replace)` sends digests to the gateway and
 * throws on refusal. Returns what was planted (paths and placements, never the decoys).
 */
export async function plantTripwires({ home = os.homedir(), agentId, origin, placements = DEFAULT_TRIPWIRE_PLACEMENTS, register, manifestFile = tripwireManifestPath(), dryRun = false }) {
  if (!agentId) throw new Error("an agent id is required (--agent <id>)");
  if (!/^https?:\/\/[^/\s]+$/.test(String(origin ?? ""))) throw new Error("the gateway origin must be a bare origin");
  for (const p of placements) if (!Object.hasOwn(TRIPWIRE_PLACEMENTS, p)) throw new Error(`unknown placement ${p}; use: ${tripwirePlacementChoices()}`);
  const manifest = readTripwireManifest(manifestFile);
  const previous = manifest.agents[agentId]?.placements ?? [];
  const slug = slugOf(agentId);
  const plan = placements.map((placement) => {
    const spec = TRIPWIRE_PLACEMENTS[placement];
    const rel = spec.rel(slug);
    const prior = previous.find((p) => p.placement === placement);
    const target = checkTarget(home, rel, prior?.digest);
    const decoy = generateDecoy();
    return { placement, target, decoy, digest: decoyDigest(decoy), content: spec.content(decoy, origin) };
  });
  if (dryRun) return { planted: plan.map(({ placement, target }) => ({ placement, path: target })), dryRun: true };

  // A rotation retires only what THIS machine planted (review R12-08).
  await register(
    plan.map(({ placement, digest }) => ({ placement, digest })),
    previous.length > 0,
    previous.map((p) => p.digest).filter((d) => typeof d === "string")
  );

  for (const item of plan) {
    fs.mkdirSync(path.dirname(item.target), { recursive: true, mode: 0o700 });
    const tmp = `${item.target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, item.content, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, item.target);
  }
  const now = new Date().toISOString();
  manifest.agents[agentId] = {
    placements: plan.map(({ placement, target, digest }) => ({ placement, path: target, digest, plantedAt: now })),
  };
  writeManifest(manifestFile, manifest);
  return { planted: plan.map(({ placement, target }) => ({ placement, path: target })), rotated: previous.length > 0 };
}

/** Retire at the gateway, then delete only the files whose decoy is still the one planted. */
export async function removeTripwires({ agentId, retire, manifestFile = tripwireManifestPath() }) {
  const manifest = readTripwireManifest(manifestFile);
  const entry = manifest.agents[agentId];
  await retire();
  const removed = [];
  const kept = [];
  for (const p of entry?.placements ?? []) {
    const st = lstatOrNull(p.path);
    if (!st || !st.isFile() || st.isSymbolicLink()) continue;
    const current = fs.readFileSync(p.path, "utf8");
    const ours = [...current.matchAll(/pc_agent_[A-Za-z0-9_-]{43}/g)].some((m) => decoyDigest(m[0]) === p.digest);
    if (ours) {
      fs.unlinkSync(p.path);
      removed.push(p.path);
    } else kept.push(p.path);
  }
  delete manifest.agents[agentId];
  writeManifest(manifestFile, manifest);
  return { removed, kept };
}
