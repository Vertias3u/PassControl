// The interactive command browser — `passcontrol settings`, and bare
// `passcontrol` on a TTY.
//
// Three constraints shaped this file, and each one rules out the obvious
// implementation, so they are worth stating:
//
// 1. NO NEW DEPENDENCY. This CLI has five, all pure JS, no native modules, and
//    `research/passport-key-protection.md` §3 calls that "a fact worth
//    protecting" — adding a native module to a credential CLI is a supply-chain
//    decision, not an implementation detail. Every TUI library is either native
//    or a large transitive tree, so the arrow keys are decoded from raw escape
//    sequences here instead. It is about forty lines.
//
// 2. THE MENU IS A FRONT DOOR, NOT A REPLACEMENT. Every flat command keeps
//    working exactly as it did. `cli/mcp/gateway.mjs`, shell scripts and agents
//    invoke these by name; a menu that swallowed them would break every caller
//    that is not a human at a terminal.
//
// 3. THE REGISTRY IS PINNED TO THE DISPATCH, NOT COPIED FROM IT. CLAUDE.md
//    records that the `env`/`configure` usage strings drifted from the dispatch
//    once already. `cli/__tests__/menu.test.mjs` parses the switch in
//    `bin/passcontrol.mjs` and fails if a command exists that this file neither
//    lists nor deliberately hides, so drift is caught by the suite rather than
//    by a user finding a command the menu forgot.

/**
 * The command groups, in the order they are shown.
 *
 * `run` is the argv this entry dispatches — an array, because several entries
 * are subcommands (`key migrate`). Nothing here calls a handler directly:
 * going through argv is what lets the menu print the exact equivalent command
 * line before running it, which is the property that makes the menu teach the
 * flat commands rather than hide them.
 *
 * `needsArgs` marks an entry that cannot run from a bare selection — it takes
 * an agent id, a file, a prompt. The browser prints the command line and stops
 * rather than guessing, because guessing an argument to `agent revoke` is not
 * a recoverable mistake.
 */
export const EFFECT_LABELS = Object.freeze({
  read: "read-only",
  preview: "preview",
  local_write: "local write",
  tenant_write: "tenant write",
  irreversible: "irreversible",
  launch: "launch",
  long_running: "long-running",
});

export const NETWORK_LABELS = Object.freeze({
  none: "no network",
  gateway: "uses the gateway",
  browser: "opens a browser",
  provider: "may contact a provider",
});

const currentFrom = (key) => (context = {}) => context[key] ?? null;
const command = ({
  id,
  label,
  run,
  detail,
  description,
  effect = "read",
  network = "none",
  keywords = [],
  current = () => null,
  needsArgs = false,
  guide = null,
  returnToMenu = effect === "read" || effect === "preview",
}) => ({
  id,
  label,
  run,
  detail,
  description,
  effect,
  network,
  keywords: [...new Set([...id.split("-"), ...run, ...keywords])],
  current,
  needsArgs,
  guide,
  returnToMenu,
});

export const GROUPS = [
  {
    section: "CONTROL",
    title: "Setup & config",
    hint: "connect this machine to a gateway",
    items: [
      command({ id: "login", label: "Sign in through the browser", run: ["login"], detail: "login", description: "Approve this machine and create local credentials.", effect: "local_write", network: "browser", current: currentFrom("account") }),
      command({ id: "init", label: "Configure by hand, no browser", run: ["init"], detail: "init", description: "Write a project or global PassControl configuration interactively.", effect: "local_write", current: currentFrom("config") }),
      command({ id: "env", label: "Print integration settings", run: ["env"], detail: "env", description: "Print environment variables for a supported agent integration.", network: "none", current: currentFrom("provider") }),
      command({ id: "configure", label: "Preview integration config", run: ["configure"], detail: "configure <integration>", description: "Choose an integration and preview its configuration without writing a file.", effect: "preview", guide: "integration", needsArgs: true, current: currentFrom("provider") }),
      command({ id: "logout", label: "Sign out and clear credentials", run: ["logout"], detail: "logout", description: "Remove local credentials and optionally revoke their remote capabilities.", effect: "tenant_write", network: "gateway", current: currentFrom("account") }),
      command({ id: "unlink", label: "Forget the remembered checkout", run: ["unlink"], detail: "unlink", description: "Remove the saved local app-checkout pointer.", effect: "local_write", current: currentFrom("app") }),
    ],
  },
  {
    section: "CONTROL",
    title: "Fleet",
    hint: "agents and their passports",
    items: [
      command({ id: "agent-list", label: "List agents", run: ["agent", "list"], detail: "agent list", description: "Show the fleet, lifecycle state, usage, and identifiers.", network: "gateway", current: currentFrom("fleet") }),
      command({ id: "agent-create", label: "Create an agent passport", run: ["agent", "create"], detail: "agent create <name>", description: "Create a fleet row and reveal a new private passport once.", effect: "tenant_write", network: "gateway", needsArgs: true }),
      command({ id: "agent-suspend", label: "Suspend an agent", run: ["agent", "suspend"], detail: "agent suspend <id>", description: "Temporarily refuse every new call from one active agent.", effect: "tenant_write", network: "gateway", guide: "suspend", needsArgs: true }),
      command({ id: "agent-resume", label: "Resume an agent", run: ["agent", "resume"], detail: "agent resume <id>", description: "Allow a suspended agent to authenticate again.", effect: "tenant_write", network: "gateway", guide: "resume", needsArgs: true }),
      command({ id: "kill", label: "Tenant kill switch", run: ["kill"], detail: "kill on|off", description: "Arm or disarm the workspace-wide emergency stop.", effect: "tenant_write", network: "gateway", guide: "kill", needsArgs: true, current: currentFrom("kill") }),
    ],
  },
  {
    section: "CONTROL",
    title: "Money",
    hint: "budgets and fleet spending",
    items: [
      command({ id: "spend", label: "Fleet and per-agent spend", run: ["spend"], detail: "spend", description: "Read reconciled token and monetary usage for the fleet.", network: "gateway", current: currentFrom("fleet") }),
      // Lives under Money rather than Evidence, and not only because Evidence is
      // full at seven rows (the 80x24 sweep in menu.test.mjs is the hard limit).
      // This row answers "what did this fleet spend, and can I prove it" — the
      // reading of it is a money question. Verifying somebody ELSE's statement
      // is the evidence question, and that one sits with the other verifiers.
      command({ id: "statements", label: "Signed spend statements", run: ["statements"], detail: "statements", description: "Show the daily chain committing to every receipt in each window.", network: "gateway" }),
    ],
  },
  {
    section: "AUDIT",
    title: "Evidence",
    hint: "events, receipts and proof",
    items: [
      command({ id: "audit", label: "Operator audit history", run: ["audit"], detail: "audit", description: "Show consequential operator actions and request identifiers.", network: "gateway" }),
      command({ id: "logs", label: "Governed call logs", run: ["logs"], detail: "logs", description: "Filter governed calls by agent, class, status, and count.", network: "gateway", guide: "logs" }),
      command({ id: "verify-receipt", label: "Verify a signed receipt", run: ["verify", "receipt"], detail: "verify receipt <jws>", description: "Verify a receipt against a pinned issuer without an account.", network: "gateway", guide: "verify-receipt", needsArgs: true }),
      command({ id: "verify-statement", label: "Verify a signed spend statement", run: ["verify", "statement"], detail: "verify statement <jws>", description: "Verify a statement against a pinned issuer without an account.", network: "gateway", guide: "verify-statement", needsArgs: true }),
      command({ id: "verify-token", label: "Verify an agent-to-agent token", run: ["verify", "token"], detail: "verify token <jwt>", description: "Verify a token against a pinned issuer and audience.", network: "gateway", guide: "verify-token", needsArgs: true }),
      command({ id: "export", label: "Save a workspace snapshot", run: ["export"], detail: "export", description: "Write a redacted workspace configuration snapshot.", effect: "local_write", network: "gateway" }),
      command({ id: "import", label: "Restore agents from a snapshot", run: ["import"], detail: "import <file>", description: "Add missing configuration from a snapshot without overwriting agents.", effect: "tenant_write", network: "gateway", needsArgs: true }),
    ],
  },
  {
    section: "AUDIT",
    title: "Trust",
    hint: "where the passport key lives",
    items: [
      command({ id: "key-status", label: "Show the local key storage tier", run: ["key", "status"], detail: "key status", description: "Report where this machine resolves its passport private key.", current: currentFrom("key") }),
      command({ id: "key-migrate", label: "Move a file key into the OS store", run: ["key", "migrate"], detail: "key migrate", description: "Store the passport in the OS credential store, verify it, then remove the file copy.", effect: "local_write", guide: "key-migrate", current: currentFrom("key") }),
    ],
  },
  {
    section: "SYSTEM",
    title: "Local stack",
    hint: "run a gateway locally",
    // Shown only on a machine that HAS a PassControl checkout. See
    // `availableGroups` below for why, and why `doctor` was moved out of here.
    requires: "localStack",
    items: [
      command({ id: "setup", label: "Clone the app and start everything", run: ["setup"], detail: "setup", description: "Prepare a local checkout and start the self-hosted stack.", effect: "local_write", network: "provider" }),
      command({ id: "start", label: "Start the local stack", run: ["start"], detail: "start", description: "Start the remembered local dashboard and its dependencies.", effect: "local_write" }),
      command({ id: "stop", label: "Stop the local stack", run: ["stop"], detail: "stop", description: "Stop the CLI-managed local dashboard process.", effect: "local_write" }),
      command({ id: "restart", label: "Restart the local dashboard", run: ["restart"], detail: "restart", description: "Restart only the CLI-managed dashboard process.", effect: "local_write" }),
      command({ id: "local-logs", label: "Show local dashboard logs", run: ["local-logs"], detail: "local-logs", description: "Follow the local dashboard process output.", effect: "long_running" }),
    ],
  },
  {
    section: "SYSTEM",
    title: "Status & tools",
    hint: "health and diagnostics",
    items: [
      command({ id: "doctor", label: "Diagnose setup", run: ["doctor"], detail: "doctor", description: "Inspect the local stack, gateway, credentials, and protocol compatibility.", network: "gateway", current: currentFrom("gateway") }),
      command({ id: "status", label: "Show cockpit status", run: ["status"], detail: "status", description: "Show local configuration, gateway health, and the next useful action.", network: "gateway", current: currentFrom("gateway") }),
      command({ id: "version", label: "CLI, gateway and schema versions", run: ["version"], detail: "version", description: "Compare CLI, gateway build, schema, and protocol versions.", network: "gateway" }),
      command({ id: "open", label: "Open the Control Tower", run: ["open"], detail: "open", description: "Open the configured dashboard in the system browser.", effect: "launch", network: "browser" }),
      command({ id: "call", label: "Make a governed model call", run: ["call"], detail: "call \"<prompt>\"", description: "Mint a visa and make a billable governed provider call.", effect: "tenant_write", network: "provider", needsArgs: true, current: currentFrom("provider") }),
    ],
  },
  {
    section: null,
    danger: true,
    title: "Danger zone",
    hint: "revoke, rotate or destroy",
    items: [
      command({ id: "agent-rotate", label: "Rotate a passport key", run: ["agent", "rotate"], detail: "agent rotate <id>", description: "Replace an agent passport and reveal a new private key once.", effect: "irreversible", network: "gateway", needsArgs: true }),
      command({ id: "agent-revoke", label: "Revoke an agent permanently", run: ["agent", "revoke"], detail: "agent revoke <id>", description: "Permanently prevent an agent from authenticating again.", effect: "irreversible", network: "gateway", needsArgs: true }),
      command({ id: "keygen-instance", label: "Create a receipt-signing key", run: ["keygen", "instance"], detail: "keygen instance", description: "Reveal a new instance signing seed; replacing a live key requires a rotation plan.", effect: "irreversible", needsArgs: true }),
      command({ id: "reset", label: "Destroy and recreate the local stack", run: ["reset"], detail: "reset --local --confirm RESET", description: "Delete and recreate local stack state after an explicit typed confirmation.", effect: "irreversible", needsArgs: true }),
    ],
  },
];

/**
 * Commands the browser deliberately does not list, each with its reason. The
 * pin test reads this map, so "absent from the menu" is always a recorded
 * decision rather than an oversight — that is the whole point of writing the
 * reasons down next to the names.
 */
export const HIDDEN = {
  help: "the menu replaces it in this mode",
  settings: "this is the menu itself",
  menu: "an alias of settings",
  mcp: "a long-lived stdio server — it owns the terminal and would never return to the menu",
  sidecar: "a long-lived foreground server, same reason as mcp",
  fleet: "an alias of `agent`, already listed once under Fleet",
  agent: "reached through its subcommands under Fleet",
  key: "reached through its subcommands under Trust",
  keygen: "reached through its `instance` subcommand under Trust",
  verify: "reached through its subcommands under Evidence",
  try: "kept as an explanatory compatibility error, but no longer performs an operation",
};

/** Every top-level command name the menu can reach, flattened. */
export function menuCommands() {
  const names = new Set();
  for (const group of GROUPS) for (const item of group.items) names.add(item.run[0]);
  return names;
}

export function allMenuItems(groups = GROUPS) {
  const seen = new Set();
  const items = [];
  for (const group of groups) {
    for (const item of group.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push({ ...item, groupTitle: group.title });
    }
  }
  return items;
}

export function searchMenu(query, groups = GROUPS) {
  const needle = String(query ?? "").trim().toLowerCase();
  const items = allMenuItems(groups);
  if (!needle) return items;

  // What a row IS beats what a row MENTIONS.
  //
  // The filter searches descriptions too, which is what makes the search useful
  // — but an unranked filter returns group order, so a row that merely mentions
  // the word in prose can land above the row that IS the word. Typing "receipt"
  // and getting "Signed spend statements" first (its description explains that
  // the chain commits to every receipt) is the case that surfaced this: the
  // description is accurate and worth keeping, and the ranking is what was wrong.
  //
  // Two tiers only, and the sort is stable, so within a tier group order is
  // preserved exactly as before.
  const named = (item) => `${item.label} ${item.detail}`.toLowerCase().includes(needle);
  const matches = items.filter((item) =>
    [item.label, item.detail, item.description, item.groupTitle, ...item.keywords]
      .join(" ")
      .toLowerCase()
      .includes(needle)
  );
  return [...matches.filter(named), ...matches.filter((item) => !named(item))];
}

export function recentEligible(item) {
  return item?.effect === "read" || item?.effect === "preview";
}

export function updateRecents(recentIds, item, limit = 5) {
  if (!recentEligible(item)) return [...recentIds];
  return [item.id, ...recentIds.filter((id) => id !== item.id)].slice(0, limit);
}

/**
 * The groups whose commands this machine can actually run.
 *
 * A group may name ONE capability in `requires`, and is drawn only when the
 * caller reports it. Today there is exactly one: `Local stack` needs a
 * PassControl checkout on this disk, and without one every command in it —
 * `start`, `stop`, `restart`, `local-logs` — fails on the first line. Offering
 * them is not a small inaccuracy; it is a menu describing a different machine.
 *
 * The second reason is a product one and worth writing down rather than
 * discovering later. The default install of this CLI is a CLIENT for a hosted
 * gateway, and `setup` clones the whole server and runs it locally. A front
 * door that opens with that offer is telling every new user, unprompted, to go
 * and run the thing themselves. That belongs in the documentation of a
 * self-hosted deployment, chosen deliberately, not on the first screen of a
 * client install.
 *
 * NOTHING IS REMOVED FROM THE CLI. `passcontrol setup`, `start`, `stop`,
 * `restart` and `local-logs` all still work exactly as they did when typed, and
 * `passcontrol --help` still lists every one of them — the menu is a front door,
 * not a replacement, and someone self-hosting is following a README rather than
 * hunting through a menu. `cli/__tests__/menu.test.mjs` still pins every
 * dispatch command to this registry, so nothing here can quietly disappear.
 *
 * `doctor` was moved OUT of that group and into Status & tools for this change.
 * It reports on the gateway, the credentials and the protocol as well as the
 * local stack, so it is exactly the command a client install wants when
 * something is wrong — and it would have been the collateral damage of hiding
 * the group around it.
 */
export function availableGroups(capabilities = {}, groups = GROUPS) {
  return groups.filter((group) => !group.requires || capabilities[group.requires] === true);
}

export function groupsWithRecents(recentIds = [], groups = GROUPS) {
  const byId = new Map(allMenuItems(groups).map((item) => [item.id, item]));
  const items = recentIds.map((id) => byId.get(id)).filter(Boolean);
  if (items.length === 0) return groups;
  return [{ title: "Recent", hint: "safe choices from this session", items }, ...groups];
}

// ── key decoding ────────────────────────────────────────────────────────────

const ESC = "\x1b";
const CTRL_C = "\x03";

/**
 * Map one chunk of stdin to an intent, or null for a key we ignore.
 *
 * Ctrl-C is decoded HERE rather than by a SIGINT handler, because raw mode is
 * precisely the mode in which the terminal stops translating \x03 into a
 * signal. A menu that left it to SIGINT would be unquittable by the one key
 * everybody reaches for first.
 */
export function decodeKey(chunk) {
  const s = String(chunk);
  if (s === CTRL_C) return "abort";
  if (s === `${ESC}[A`) return "up";
  if (s === `${ESC}[B`) return "down";
  if (s === `${ESC}[C`) return "enter";
  if (s === `${ESC}[D`) return "back";
  if (s === `${ESC}[H`) return "first";
  if (s === `${ESC}[F`) return "last";
  if (s === "\r" || s === "\n") return "enter";
  if (s === "\x7f" || s === "\b") return "backspace";
  if (s === "\x15") return "clear";
  if (s.length === 1 && s >= " " && s !== "\x7f") return `char:${s}`;
  return null;
}

/**
 * Split a raw-mode buffer into intents, returning whatever could not yet be
 * decoded so the caller can prepend it to the next chunk.
 *
 * ONE `data` EVENT IS NOT ONE KEYPRESS, and assuming it was is the bug this
 * function exists to fix. A first version of this file decoded each chunk whole
 * and looked correct against synthetic single-key events in the unit tests —
 * then dropped three of four arrow keys when driven through a real pty, because
 * a terminal delivers held or quickly-repeated keys coalesced into one chunk
 * (`\x1b[B\x1b[B`) and just as happily splits a single escape sequence across
 * two (`\x1b` then `[B`). Neither shape matches any whole-chunk comparison, so
 * both silently decoded to nothing.
 *
 * A lone trailing ESC is therefore never decoded on its own — it is held back,
 * because it cannot be told apart from the first byte of a sequence still in
 * flight. The cost is that bare Escape does nothing; `←`, `h` and `q` are the
 * documented ways out, and a key that does nothing is much cheaper than a
 * cursor that jumps because half an arrow key was read as Escape.
 */
export function consumeKeys(buffer) {
  const intents = [];
  let i = 0;
  while (i < buffer.length) {
    const rest = buffer.length - i;
    if (buffer[i] === ESC) {
      // Hold an incomplete sequence for the next chunk rather than guessing.
      if (rest < 3 && (rest === 1 || buffer[i + 1] === "[")) break;
      if (buffer[i + 1] === "[") {
        const intent = decodeKey(buffer.slice(i, i + 3));
        if (intent) intents.push(intent);
        i += 3;               // an unrecognised CSI is consumed, not replayed
        continue;
      }
      i += 1;                 // ESC followed by something else: drop the ESC
      continue;
    }
    const intent = decodeKey(buffer[i]);
    if (intent) intents.push(intent);
    i += 1;
  }
  return { intents, rest: buffer.slice(i) };
}

/** Move a cursor within `length`, wrapping at both ends. */
export function moveCursor(index, intent, length) {
  if (length <= 0) return 0;
  if (intent === "up") return (index - 1 + length) % length;
  if (intent === "down") return (index + 1) % length;
  if (intent === "first") return 0;
  if (intent === "last") return length - 1;
  return index;
}

export const initialState = Object.freeze({ group: null, index: 0, chosen: null, done: null, search: null });

/**
 * The pure state machine behind the browser, kept separate from rendering and
 * from stdin so the navigation can be tested without a terminal at all: the
 * tests drive it with a list of intents and assert where it lands.
 *
 * `back` at the top level does NOT quit. Leaving on a key the user pressed to
 * mean "up one level" would throw away their place for a keystroke that meant
 * the opposite; `q` and Ctrl-C are the two ways out, and both are on screen.
 */
export function reduce(state, intent, groups = GROUPS) {
  // Array.prototype.reduce passes its index as a third argument; accepting the
  // pure reducer directly is convenient in tests and callers, so ignore it.
  if (!Array.isArray(groups)) groups = GROUPS;
  if (state.search) {
    const results = searchMenu(state.search.query, groups);
    if (intent === "abort") return { ...state, done: "abort" };
    if (intent === "back") return { ...state, search: null };
    if (intent === "up" || intent === "down" || intent === "first" || intent === "last") {
      return {
        ...state,
        search: { ...state.search, index: moveCursor(state.search.index, intent, results.length) },
      };
    }
    if (intent === "enter") {
      const chosen = results[state.search.index];
      return chosen ? { ...state, chosen } : state;
    }
    if (intent === "backspace") {
      const query = state.search.query.slice(0, -1);
      const next = searchMenu(query, groups);
      return { ...state, search: { query, index: Math.min(state.search.index, Math.max(0, next.length - 1)) } };
    }
    if (intent === "clear") return { ...state, search: { query: "", index: 0 } };
    if (intent.startsWith("char:")) {
      const query = state.search.query + intent.slice(5);
      return { ...state, search: { query, index: 0 } };
    }
    return state;
  }

  if (intent.startsWith("char:")) {
    const char = intent.slice(5);
    if (char === "/") return { ...state, search: { query: "", index: 0 } };
    if (char === "k") intent = "up";
    else if (char === "j") intent = "down";
    else if (char === "l") intent = "enter";
    else if (char === "h") intent = "back";
    else if (char === "q") intent = "quit";
    else return state;
  }

  const level = state.group === null ? groups : groups[state.group].items;
  switch (intent) {
    case "up":
    case "down":
    case "first":
    case "last":
      return { ...state, index: moveCursor(state.index, intent, level.length) };
    case "enter":
      if (state.group === null) return { ...state, group: state.index, index: 0 };
      return { ...state, chosen: groups[state.group].items[state.index] };
    case "back":
      if (state.group === null) return state;
      return { ...state, group: null, index: state.group, chosen: null };
    case "quit":
    case "abort":
      return { ...state, done: intent };
    default:
      return state;
  }
}

// ── rendering ───────────────────────────────────────────────────────────────

// A five-step ink scale, all inside the 16-colour set. Nothing in this CLI
// emits 38;5; or 38;2;, and a single file that did would look wrong beside the
// rest and can vanish outright on a terminal that has not been told its palette.
//
// The two dim levels are the point of the scale: `\x1b[2m` carries the
// descriptions and `\x1b[90m` sits a step below it for section headers and the
// footer, so the eye lands on titles first, descriptions second, and chrome
// last. On the terminals where `2m` is a no-op there is still one real level of
// separation rather than none.
const DIM = "\x1b[2m";
const FAINT = "\x1b[90m";
const BOLD = "\x1b[1m";
const LIME = "\x1b[92m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

export const SEARCH_CHROME_LINES = 19;
const GROUP_TITLE_WIDTH = 20;
const ITEM_LABEL_WIDTH = 38;

/**
 * Render the current level to an array of lines.
 *
 * Returns lines rather than printing them so a test can assert on what the
 * user would see — including that the selected row is the one marked — without
 * a pty. `colour` is off in tests, and off whenever stdout is not a TTY.
 *
 * Selection is a lime caret and a bold title, never a filled bar. A reversed
 * block is the loudest thing a terminal can draw, and spending that on "where
 * the cursor is" left nothing louder for "this row destroys an agent". The
 * caret costs one column and reads as a pointer rather than as an alarm.
 *
 * Every padEnd here runs on plain text and the colour is applied afterwards.
 * Padding a coloured string counts the escape bytes as characters, which pushes
 * the next column right by an invisible amount — and since only the selected
 * row is bold, the whole table would shift a few columns as the cursor moved.
 */
function detailLines(item, context, { dim, bold, danger }) {
  if (!item) return [];
  const current = item.current(context);
  const effect = EFFECT_LABELS[item.effect];
  // An irreversible effect is the one label on this screen that is a warning
  // rather than a fact, so it is the one that gets the red.
  const painted = item.effect === "irreversible" ? danger(effect) : dim(effect);
  // The label is deliberately NOT repeated here. It is already on screen one
  // line up, bold, under the cursor — and the frame has to fit 80x24 with a
  // six-item group above this block. The exact command takes its place as the
  // heading, which is also the thing this panel exists to teach.
  return [
    "",
    bold(`  passcontrol ${item.detail}`),
    `  ${item.description}`,
    `  ${painted}${dim(` \u00b7 ${NETWORK_LABELS[item.network]}`)}`,
    ...(current === null || current === "" ? [] : [dim(`  Current: ${current}`)]),
  ];
}

export function render(state, { colour = true, header = "", groups = GROUPS, context = {}, maxResults = Infinity } = {}) {
  const ink = (code) => (s) => (colour ? `${code}${s}${RESET}` : s);
  const dim = ink(DIM);
  const faint = ink(FAINT);
  const bold = ink(BOLD);
  const lime = ink(LIME);
  const danger = ink(`${RED}${BOLD}`);
  const caret = (selected) => (selected ? `  ${lime("\u203a")} ` : "    ");

  const lines = [];
  if (header) lines.push(header, "");

  if (state.search) {
    const results = searchMenu(state.search.query, groups);
    lines.push(`${faint("  Search:")} ${bold(state.search.query)}`, "");
    const windowStart = Math.max(0, state.search.index - maxResults + 1);
    const visible = results.slice(windowStart, windowStart + maxResults);
    visible.forEach((item, i) => {
      const selected = windowStart + i === state.search.index;
      const label = item.label.padEnd(ITEM_LABEL_WIDTH);
      lines.push(selected
        ? `${caret(true)}${bold(label)}${dim(item.groupTitle)}`
        : `${caret(false)}${label}${faint(item.groupTitle)}`);
    });
    if (results.length === 0) lines.push(faint("  No matching commands"));
    if (results.length > visible.length) lines.push(faint(`  \u2026 showing ${windowStart + 1}-${windowStart + visible.length} of ${results.length}`));
    lines.push(...detailLines(results[state.search.index], context, { dim, bold, danger }));
    lines.push("", faint("  type to filter    \u2191\u2193 navigate    \u21b5 run    \u2190 close"));
    return lines;
  }

  if (state.group === null) {
    lines.push(bold("  Choose a group"));
    // Section headings are drawn, never navigated. They are not entries in
    // `groups`, so `moveCursor` and `reduce` keep counting rows exactly as they
    // did — the arrow-key arithmetic is untouched by this grouping, which is
    // what makes it a change of appearance and not of behaviour.
    //
    // A named heading is its own separator and gets no blank line above it. The
    // whole top level has to fit an 80x24 terminal, and it does not clear the
    // screen and redraw so much as scroll the title off it: `browse` writes the
    // frame after \x1b[2J\x1b[H, so one line too many costs the header on every
    // keystroke. Three blank lines of breathing room were three lines too many.
    let lastSection;
    groups.forEach((group, i) => {
      if (group.section !== lastSection) {
        // A section with no name — Recent at the top, Danger zone at the
        // bottom — gets a blank line and no heading. One row under a heading
        // reads as a category; the same row after a gap reads as set apart.
        if (group.section) lines.push(faint(`  ${group.section}`));
        else if (i > 0) lines.push("");
        lastSection = group.section;
      }
      const selected = i === state.index;
      const title = group.title.padEnd(GROUP_TITLE_WIDTH);
      const name = selected ? (group.danger ? danger(title) : bold(title)) : title;
      lines.push(`${caret(selected)}${name}${selected ? dim(group.hint) : faint(group.hint)}`);
    });
    lines.push("", faint("  \u2191\u2193 navigate    \u21b5 open    / search    q quit"));
    return lines;
  }

  const group = groups[state.group];
  // Title and hint share one line here. At the top level they already sat side
  // by side, so a second line would repeat a layout the reader has just seen —
  // and this level has the least room of the three: a six-item group plus its
  // detail block plus the header has to fit the same 80x24 frame.
  const groupTitle = group.danger ? danger(`  ${group.title}`) : bold(`  ${group.title}`);
  lines.push(`${groupTitle}${faint(`  ${group.hint}`)}`, "");
  group.items.forEach((item, i) => {
    const selected = i === state.index;
    const label = item.label.padEnd(ITEM_LABEL_WIDTH);
    const detail = `passcontrol ${item.detail}`;
    lines.push(selected
      ? `${caret(true)}${bold(label)}${dim(detail)}`
      : `${caret(false)}${label}${faint(detail)}`);
  });
  lines.push(...detailLines(group.items[state.index], context, { dim, bold, danger }));
  lines.push("", faint("  \u2191\u2193 navigate    \u21b5 run    \u2190 back    q quit"));
  return lines;
}

// ── the interactive driver ──────────────────────────────────────────────────

const SHOW_CURSOR = "\x1b[?25h";
const HIDE_CURSOR = "\x1b[?25l";
const CLEAR = "\x1b[2J\x1b[H";

/**
 * Print the whole menu as plain text. This is what a non-TTY gets, and it is a
 * real answer rather than an error: piping `passcontrol settings` into a pager
 * or a file should show the map, not fail because nobody is holding a keyboard.
 */
export function printStatic(write, { header = "", groups = GROUPS } = {}) {
  if (header) write(`${header}\n\n`);
  let lastSection;
  // Filtered the same way the browser is, and silently. A piped map describes
  // the machine it was produced on; a footnote explaining what was left out
  // would put the offer back on the screen it was taken off.
  for (const group of groups) {
    // The same sections the interactive top level draws, so a piped map and a
    // browsed one describe the CLI with the same shape.
    if (group.section && group.section !== lastSection) write(`  ${group.section}\n`);
    lastSection = group.section;
    write(`  ${group.title} — ${group.hint}\n`);
    for (const item of group.items) {
      write(`    passcontrol ${item.detail}\n`);
    }
    write("\n");
  }
  write("  An interactive menu is available when this runs on a terminal.\n");
}

/**
 * Drive the browser against a real terminal and resolve with the chosen entry,
 * or null if the user left without choosing.
 *
 * The `finally` is the load-bearing part of this function. Raw mode with a
 * hidden cursor is a global change to the user's terminal, not to this process:
 * throwing out of the loop without restoring it leaves them in a shell with no
 * echo and no cursor, which reads as a hung machine rather than as a crashed
 * command. Every exit path — chosen, quit, Ctrl-C, an exception from render —
 * goes through it.
 */
export function browse({ stdin, stdout, header = "", recentIds = [], context = {}, status = null, capabilities = {} } = {}) {
  const input = stdin ?? process.stdin;
  const output = stdout ?? process.stdout;
  const colour = Boolean(output.isTTY) && !process.env.NO_COLOR;
  const groups = groupsWithRecents(recentIds, availableGroups(capabilities));

  return new Promise((resolve, reject) => {
    let state = initialState;
    let settled = false;
    let remoteStatus = null;

    const draw = () => {
      const renderedHeader = typeof header === "function" ? header(remoteStatus) : header;
      const renderedContext = { ...context, ...(remoteStatus?.current ?? {}) };
      output.write(CLEAR);
      output.write(`${render(state, {
        colour,
        header: renderedHeader,
        groups,
        context: renderedContext,
        // Everything the search level draws around its results, counted at its
        // worst: seven header lines, the blank after them, the query line and
        // its blank, the "… showing" line, six detail lines, and a blank plus
        // the footer. Retuned with the header — it used to reserve twelve, for
        // a header three lines shorter with no detail block above the fold.
        // `cli/__tests__/menu.test.mjs` pins the arithmetic against the frame.
        maxResults: Math.max(3, (Number(output.rows) || 24) - SEARCH_CHROME_LINES),
      }).join("\n")}\n`);
    };

    const restore = () => {
      input.off("data", onData);
      if (input.isTTY && typeof input.setRawMode === "function") input.setRawMode(false);
      input.pause();
      output.write(SHOW_CURSOR);
    };

    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      try { restore(); } catch { /* the terminal is already gone; the result still stands */ }
      if (error) reject(error); else resolve(value);
    };

    let pending = "";
    function onData(chunk) {
      try {
        const { intents, rest } = consumeKeys(pending + String(chunk));
        pending = rest;
        if (intents.length === 0) return;
        for (const intent of intents) {
          state = reduce(state, intent, groups);
          // Stop at the first intent that ends the session. Any coalesced bytes
          // after the selection are deliberately discarded, so a buffered
          // Enter cannot answer the command's next confirmation prompt.
          if (state.chosen) return finish(state.chosen);
          if (state.done) return finish(null);
        }
        draw();
      } catch (error) {
        finish(null, error);
      }
    }

    try {
      if (input.isTTY && typeof input.setRawMode === "function") input.setRawMode(true);
      input.resume();
      input.setEncoding("utf8");
      output.write(HIDE_CURSOR);
      input.on("data", onData);
      draw();
      if (status && typeof status.then === "function") {
        Promise.resolve(status)
          .then((value) => {
            if (settled) return;
            remoteStatus = value;
            draw();
          })
          .catch(() => {
            if (settled) return;
            remoteStatus = { unavailable: true };
            draw();
          });
      }
    } catch (error) {
      finish(null, error);
    }
  });
}
