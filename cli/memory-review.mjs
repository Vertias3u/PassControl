// `passcontrol memory review` (idea 13): the text of the memory entries waiting at customs,
// shown on the owner's own machine, where it never left. The gateway holds only hashes;
// the running sidecar matches them to this workspace's files (cli/memory-custody-sidecar.mjs).
// Deciding happens on the agent's page (cookie session, MFA), never here: this machine is
// the agent's machine, and anything that runs here, the agent can run.
//
// Entry text is the attacker's text when the entry is hostile, so it is printed inert: every
// control character but newline and tab becomes a visible escape, so it cannot move the
// cursor, recolour the terminal or overwrite the line that says where it came from.

const STATUS = { stamped: "written after outside content", unrecorded: "no custody record", rejected: "REJECTED, still in the file: remove it" };
const KIND = { web: "web or search", mcp: "MCP", shell_network: "network shell command", outside_read: "file outside the workspace", workspace_read: "third-party workspace", memory_arrival: "memory that was itself waiting" };

// C0/C1 controls, zero-width and bidi controls, line/paragraph separators, BOM.
const INERT = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]", "g");

/** Control characters made visible, so hostile text cannot drive the terminal. */
export function inert(text) {
  return String(text).replace(INERT, (c) => `\\u{${c.codePointAt(0).toString(16)}}`);
}

/** The lines `memory review` prints, from the sidecar's answer. Pure, for tests. */
export function formatReview(answer, { dashboard = "the agent's page on the dashboard" } = {}) {
  if (answer.state === "off") return ["Memory custody is off for this agent."];
  if (answer.state === "unknown") return ["The sidecar has not read this agent's settings yet. Try again in a few seconds."];
  if (answer.state === "unavailable") return ["The sidecar could not ask the gateway. While it cannot, the agent is held."];
  const items = Array.isArray(answer.items) ? answer.items.filter((i) => i.status === "rejected" || i.seen) : [];
  if (!items.length) return ["Nothing waits at customs."];
  const lines = [`${items.length} ${items.length === 1 ? "entry waits" : "entries wait"}. Decide on ${dashboard}; this command only shows them.`, ""];
  const groups = new Map();
  for (const i of items) {
    const g = i.review_id ?? "(no review yet)";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(i);
  }
  for (const [review, list] of groups) {
    lines.push(`Review ${review}`);
    for (const i of list) {
      const origin = i.writer_session
        ? `written by session ${inert(i.writer_session)}${i.marks?.length ? ` after ${i.marks.map((k) => KIND[k] ?? inert(k)).join(", ")}` : ""}${i.hosts?.length ? ` (${i.hosts.map(inert).join(", ")})` : ""}`
        : "no session wrote it that PassControl saw";
      lines.push(`  [${String(i.key).slice(0, 12)}] ${STATUS[i.status] ?? inert(i.status)}; ${origin}`);
      if (i.local) {
        lines.push(`    ${inert(i.local.file)}${i.local.scope?.length ? `  under ${i.local.scope.map(inert).join(" > ")}` : ""}`);
        for (const l of inert(i.local.text).split("\n")) lines.push(`    | ${l}`);
      } else {
        lines.push("    (not in this workspace's files now: it may be in another workspace, or already removed)");
      }
    }
    lines.push("");
  }
  return lines;
}

export async function memoryReviewCommand({ sidecarUrl, sidecarKey = null, cwd = process.cwd(), client = "claude-code", fetchImpl = fetch, print = console.log }) {
  const url = `${sidecarUrl.replace(/\/+$/, "")}/_passcontrol/memory?cwd=${encodeURIComponent(cwd)}${client === "codex" ? "&client=codex" : ""}`;
  let answer;
  try {
    // The sidecar's own paths ask for its key (review C-03 follow-up).
    const res = await fetchImpl(url, { headers: sidecarKey ? { authorization: `Bearer ${sidecarKey}` } : {}, signal: AbortSignal.timeout(10_000) });
    answer = await res.json();
    if (res.status === 401) throw Object.assign(new Error("keyless"), { keyless: true });
  } catch (error) {
    if (error?.keyless) {
      throw new Error(`The sidecar at ${sidecarUrl} asked for its key, and this machine's config has no matching passport. Run \`passcontrol login\`, then this again.`);
    }
    throw new Error(`No sidecar answered at ${sidecarUrl}. Start it with \`passcontrol sidecar\`, then run this again.`);
  }
  for (const line of formatReview(answer)) print(line);
}
