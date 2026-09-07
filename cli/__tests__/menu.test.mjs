// The interactive command browser.
//
// The first describe block is the one that matters over time: it reads the
// actual dispatch out of bin/passcontrol.mjs and compares it against the
// registry, in both directions. CLAUDE.md records that the `env`/`configure`
// usage strings drifted from the dispatch once already, and a menu is a much
// better hiding place for that drift than a usage string — nobody diffs a menu
// against a switch by eye. So the suite does it.
//
// Everything else is tested WITHOUT a terminal. `reduce` and `decodeKey` are
// pure, and `browse` takes its streams by injection, so none of these tests
// needs a pty or leaves the runner's own stdin in raw mode.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  GROUPS,
  HIDDEN,
  browse,
  consumeKeys,
  decodeKey,
  initialState,
  allMenuItems,
  groupsWithRecents,
  menuCommands,
  moveCursor,
  printStatic,
  availableGroups,
  reduce,
  SEARCH_CHROME_LINES,
  searchMenu,
  render,
  updateRecents,
} from "../menu.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "passcontrol.mjs");

/**
 * Every command `main` can actually handle.
 *
 * Two sources, because the CLI has two: the `case "x":` arms of the top-level
 * switch, and the handful answered by an `if` before the switch is reached.
 * The early ones are derived from the source too rather than hardcoded — the
 * first draft of this helper read only the switch, and the suite immediately
 * reported `version` as a menu entry pointing at nothing. It was the helper
 * that was wrong, not the menu, and a hardcoded list would have rotted the
 * same way the next time a command moved.
 */
function dispatchCommands() {
  const source = fs.readFileSync(CLI, "utf8");
  const start = source.indexOf("switch (command) {");
  expect(start, "main's dispatch switch should exist").toBeGreaterThan(-1);
  const body = source.slice(start);
  const end = body.indexOf("\n    default:");
  expect(end, "the dispatch switch should have a default arm").toBeGreaterThan(-1);

  const cases = [...body.slice(0, end).matchAll(/case "([a-z][a-z-]*)":/g)].map((m) => m[1]);
  const early = [...source.slice(0, start).matchAll(/command === "([a-z][a-z-]*)"/g)].map((m) => m[1]);
  expect(early, "help and version are answered before the switch").toEqual(
    expect.arrayContaining(["help", "version"])
  );
  return new Set([...cases, ...early]);
}

describe("the registry is pinned to the dispatch", () => {
  it("lists or deliberately hides every command the CLI dispatches", () => {
    const known = menuCommands();
    const unaccounted = [...dispatchCommands()].filter((c) => !known.has(c) && !(c in HIDDEN));
    // A new command must be put in a group or given a reason in HIDDEN. Doing
    // neither is how a command becomes unreachable from the front door without
    // anyone deciding that it should be.
    expect(unaccounted).toEqual([]);
  });

  it("never offers a command the dispatch cannot handle", () => {
    const dispatch = dispatchCommands();
    const dangling = [...menuCommands()].filter((c) => !dispatch.has(c));
    expect(dangling).toEqual([]);
  });

  it("carries no stale exclusion", () => {
    // Every hidden name must still be a command, or its reason is describing
    // something that no longer exists.
    const dispatch = dispatchCommands();
    const stale = Object.keys(HIDDEN).filter((c) => !dispatch.has(c));
    expect(stale).toEqual([]);
  });

  it("gives every hidden command a non-empty reason", () => {
    for (const [name, reason] of Object.entries(HIDDEN)) {
      expect(reason, `${name} should say why it is hidden`).toBeTruthy();
    }
  });

  it("never lets the menu execute a long-lived server", () => {
    // The invariant is that selecting a row can never hand the terminal to a
    // server that runs until killed — that would look like the menu had hung.
    // It used to be enforced by keeping those commands out of the menu
    // entirely, which also made them undiscoverable: `sidecar` is the only
    // 0.9.0 path that attaches sender proofs, so under `required` mode the one
    // mandatory command was the one absent from the front door. A `needsArgs`
    // row prints the command line and returns to the menu without running
    // anything (`bin/passcontrol.mjs`, the "Command template" branch), which
    // keeps the invariant and drops the discoverability cost.
    //
    // Derived from the row metadata rather than a hardcoded pair, so the next
    // server command is covered without editing this test.
    const servers = new Set(["mcp", "sidecar"]);
    for (const item of allMenuItems()) {
      if (!servers.has(item.run[0])) continue;
      expect(item.needsArgs, `${item.id} must never run from a bare selection`).toBe(true);
      expect(item.returnToMenu, `${item.id} must not end the session`).toBe(true);
    }
  });

  it("lists the sidecar, because required mode makes it mandatory", () => {
    expect(menuCommands().has("sidecar")).toBe(true);
  });

  it("lists both long-lived servers, together, in their own group", () => {
    // The reason `mcp` was hidden was never that a listed server would hijack
    // the menu — a `needsArgs` row prints the command and returns. It was that
    // the frame was full in both dimensions: every group already rendered at 23
    // lines, and a ninth group overflowed the top level, which sat at 23 with
    // eight. The previous version of this test PINNED that and said to list mcp
    // the day the layout gained a line. Dropping the "Choose a group" heading
    // gained the line, so both servers are listed now, in one group.
    const servers = GROUPS.find((group) => group.title === "Connect an agent");
    expect(servers, "the servers group should exist").toBeTruthy();
    expect(servers.items.map((item) => item.run[0])).toEqual(["sidecar", "mcp"]);
    expect(HIDDEN).not.toHaveProperty("mcp");
    expect(HIDDEN).not.toHaveProperty("sidecar");
  });

  it("requires complete, stable metadata for every listed command", () => {
    const items = allMenuItems();
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    for (const item of items) {
      expect(item.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(item.description).toBeTruthy();
      expect(item.run.length).toBeGreaterThan(0);
      expect(["read", "preview", "local_write", "tenant_write", "irreversible", "launch", "long_running"]).toContain(item.effect);
      expect(["none", "gateway", "browser", "provider"]).toContain(item.network);
      expect(Array.isArray(item.keywords)).toBe(true);
      expect(item.keywords.length).toBeGreaterThan(0);
      expect(typeof item.current).toBe("function");
      expect(typeof item.returnToMenu).toBe("boolean");
    }
  });

  it("never executes a danger-zone command directly", () => {
    const danger = GROUPS.find((group) => group.title === "Danger zone");
    expect(danger.items).not.toHaveLength(0);
    for (const item of danger.items) {
      expect(item.effect).toBe("irreversible");
      expect(item.needsArgs).toBe(true);
      expect(item.guide).toBeNull();
    }
  });
});

describe("keys", () => {
  it("decodes the arrow keys and their vi equivalents", () => {
    expect(decodeKey("\x1b[A")).toBe("up");
    expect(decodeKey("\x1b[B")).toBe("down");
    expect(decodeKey("k")).toBe("char:k");
    expect(decodeKey("j")).toBe("char:j");
    expect(decodeKey("\r")).toBe("enter");
    expect(decodeKey("\x1b[D")).toBe("back");
    expect(decodeKey("q")).toBe("char:q");
  });

  it("treats Ctrl-C as an abort", () => {
    // In raw mode the terminal stops turning \x03 into SIGINT, so if this
    // returned null the menu would be unquittable by the key everyone tries.
    expect(decodeKey("\x03")).toBe("abort");
  });

  it("ignores keys it has no meaning for", () => {
    expect(decodeKey("z")).toBe("char:z");
    expect(decodeKey("\x1b[Z")).toBeNull();
  });
});

describe("one data event is not one keypress", () => {
  // These are the regression the unit tests could not have found. Driving the
  // menu through a real pty dropped three of four arrow keys, because a
  // terminal coalesces quickly-repeated keys into one chunk and splits single
  // escape sequences across two. Both shapes decoded to nothing.
  it("decodes several keys arriving in one chunk", () => {
    expect(consumeKeys("\x1b[B\x1b[B\x1b[B").intents).toEqual(["down", "down", "down"]);
  });

  it("decodes an escape sequence split across two chunks", () => {
    const first = consumeKeys("\x1b");
    expect(first.intents).toEqual([]);
    expect(first.rest).toBe("\x1b");
    expect(consumeKeys(first.rest + "[B").intents).toEqual(["down"]);
  });

  it("holds back a partial sequence instead of misreading it", () => {
    // \x1b[ alone must not be consumed: the letter that decides which key it
    // was has not arrived yet.
    expect(consumeKeys("\x1b[").rest).toBe("\x1b[");
  });

  it("mixes escape sequences and plain keys in one chunk", () => {
    expect(consumeKeys("\x1b[Bjq").intents).toEqual(["down", "char:j", "char:q"]);
  });

  it("consumes an unrecognised escape sequence rather than replaying it", () => {
    // Leaving \x1b[Z in the buffer would make every later key decode against a
    // stale prefix, which is worse than ignoring an unknown key.
    const out = consumeKeys("\x1b[Zj");
    expect(out.intents).toEqual(["char:j"]);
    expect(out.rest).toBe("");
  });

  it("finds Ctrl-C even when it arrives behind other keys", () => {
    expect(consumeKeys("jj\x03").intents).toEqual(["char:j", "char:j", "abort"]);
  });
});

describe("cursor movement", () => {
  it("wraps at both ends", () => {
    expect(moveCursor(0, "up", 4)).toBe(3);
    expect(moveCursor(3, "down", 4)).toBe(0);
  });

  it("survives an empty level rather than returning -1", () => {
    expect(moveCursor(0, "up", 0)).toBe(0);
  });
});

describe("navigation", () => {
  const drive = (intents) => intents.reduce(reduce, initialState);

  it("enters a group and selects an item", () => {
    const state = drive(["down", "enter", "down", "enter"]);
    expect(state.chosen).toEqual(GROUPS[1].items[1]);
  });

  it("returns from a group to the row it came from", () => {
    // Landing back on the first row after backing out of the fourth group
    // would silently punish the user for looking.
    const state = drive(["down", "down", "down", "enter", "down", "back"]);
    expect(state.group).toBeNull();
    expect(state.index).toBe(3);
  });

  it("does not quit when back is pressed at the top level", () => {
    const state = drive(["back"]);
    expect(state.done).toBeNull();
    expect(state.group).toBeNull();
  });

  it("ends on quit and on abort", () => {
    expect(drive(["quit"]).done).toBe("quit");
    expect(drive(["down", "enter", "abort"]).done).toBe("abort");
  });
});

describe("search", () => {
  const drive = (intents) => intents.reduce(reduce, initialState);

  it("searches labels, commands, groups, descriptions, and keywords", () => {
    expect(searchMenu("suspend").map((item) => item.id)).toContain("agent-suspend");
    expect(searchMenu("agent resume").map((item) => item.id)).toContain("agent-resume");
    expect(searchMenu("trust").map((item) => item.id)).toEqual(expect.arrayContaining(["key-status", "key-migrate"]));
    expect(searchMenu("emergency stop").map((item) => item.id)).toContain("kill");
  });

  it("edits, navigates, selects, and closes without changing the group cursor", () => {
    const edited = drive(["char:/", "char:k", "char:e", "char:y", "backspace"]);
    expect(edited.search).toEqual({ query: "ke", index: 0 });
    const moved = reduce(edited, "down");
    expect(moved.search.index).toBe(1);
    expect(reduce(moved, "enter").chosen).toBeTruthy();
    const closed = reduce(moved, "back");
    expect(closed.search).toBeNull();
    expect(closed.group).toBeNull();
  });
});

describe("session recents", () => {
  it("keeps five unique read-only or preview selections and no writes", () => {
    const items = new Map(allMenuItems().map((item) => [item.id, item]));
    let ids = [];
    for (const id of ["status", "version", "audit", "logs", "key-status", "agent-list"]) {
      ids = updateRecents(ids, items.get(id));
    }
    expect(ids).toEqual(["agent-list", "key-status", "logs", "audit", "version"]);
    expect(updateRecents(ids, items.get("kill"))).toEqual(ids);
    expect(updateRecents(ids, items.get("login"))).toEqual(ids);
    expect(groupsWithRecents(ids)[0].title).toBe("Recent");
  });
});

describe("what this machine can actually run", () => {
  const localStackGroup = GROUPS.find((group) => group.title === "Local stack");
  const idsIn = (groups) => new Set(groups.flatMap((group) => group.items.map((item) => item.id)));

  it("hides the Local stack group on a machine with no checkout", () => {
    // Accuracy first: `start`, `stop`, `restart` and `local-logs` all fail on
    // their first line without a checkout, so offering them describes a
    // different machine. And `setup` clones and runs the whole server — an
    // offer that does not belong on the first screen of a client install.
    expect(localStackGroup.requires).toBe("localStack");
    expect(availableGroups({}).map((group) => group.title)).not.toContain("Local stack");
    expect(availableGroups({ localStack: false }).map((group) => group.title)).not.toContain("Local stack");
    expect(availableGroups({ localStack: true })).toEqual(GROUPS);
    // Only a literal true opens it. A truthy string from an env var read is not
    // a capability check that was actually performed.
    expect(availableGroups({ localStack: "yes" }).map((group) => group.title)).not.toContain("Local stack");
  });

  it("keeps doctor reachable when that group is hidden", () => {
    // doctor reports on the gateway, the credentials and the protocol as well
    // as the local stack, so it is exactly what a client install wants when
    // something is wrong. It lived inside the group being hidden, and moving it
    // out is the reason hiding the group is safe.
    expect(idsIn(availableGroups({}))).toContain("doctor");
    expect(localStackGroup.items.map((item) => item.id)).not.toContain("doctor");
  });

  it("hides commands from the menu without removing them from the CLI", () => {
    // The pin test above walks the dispatch in bin/passcontrol.mjs and demands
    // every command be listed or deliberately hidden. That test reads GROUPS,
    // not the filtered view — so this one states the property it depends on:
    // gating is a rendering decision, and every gated command is still in the
    // registry and still runs when typed.
    const gated = idsIn([localStackGroup]);
    expect(gated).toEqual(new Set(["setup", "start", "stop", "restart", "local-logs"]));
    for (const id of gated) expect(idsIn(GROUPS)).toContain(id);
  });

  it("does not let a stale recent resurrect a hidden group's command", () => {
    // Recents are ids from an earlier session, and a machine can lose its
    // checkout between them. Nothing in Local stack is recent-eligible today,
    // so this pins the mechanism rather than a live path: the Recent group is
    // built from the FILTERED registry, not from all of GROUPS.
    const visible = availableGroups({});
    const withGhost = groupsWithRecents(["setup", "status"], visible);
    expect(withGhost[0].title).toBe("Recent");
    expect(withGhost[0].items.map((item) => item.id)).toEqual(["status"]);
  });

  it("filters the piped map the same way, and silently", () => {
    let out = "";
    printStatic((text) => { out += text; }, { groups: availableGroups({}) });
    expect(out).not.toContain("passcontrol setup");
    expect(out).not.toContain("Local stack");
    expect(out).toContain("passcontrol doctor");
    // No footnote about what was left out: a line explaining the omission would
    // put the offer back on the screen it was just taken off.
    expect(out).not.toMatch(/self.?host/i);
  });
});

describe("rendering", () => {
  it("marks the selected row and only that row", () => {
    const lines = render({ ...initialState, index: 2 }, { colour: false });
    const marked = lines.filter((l) => l.trimStart().startsWith("›"));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain(GROUPS[2].title);
  });

  it("shows the equivalent command line beside every item", () => {
    // The menu is meant to teach the flat commands, not replace them.
    const lines = render({ ...initialState, group: 4, index: 0 }, { colour: false }).join("\n");
    for (const item of GROUPS[4].items) expect(lines).toContain(`passcontrol ${item.detail}`);
  });

  it("emits no escape sequences when colour is off", () => {
    const lines = render(initialState, { colour: false }).join("\n");
    expect(lines).not.toContain("\x1b");
  });

  it("shows exact command, current value, network use, and effect", () => {
    const lines = render(
      { ...initialState, group: 2, index: 4 },
      { colour: false, context: { kill: "tenant clear · platform clear" } }
    ).join("\n");
    expect(lines).toContain("passcontrol kill on|off");
    expect(lines).toContain("tenant write · uses the gateway");
    expect(lines).toContain("Current: tenant clear · platform clear");
  });

  // Every other test in this block runs with colour OFF, so none of them touch
  // the branch that actually paints — the branch where a padEnd applied to an
  // already-coloured string counts escape bytes as columns and shifts the rest
  // of the row right by an invisible amount. Because only the selected row is
  // bold, that bug shows up as the whole table sliding sideways as the cursor
  // moves, which no assertion on plain text can see. Stripping the escapes back
  // out has to give exactly the uncoloured frame, character for character.
  it("changes nothing but escape sequences when colour is on", () => {
    const strip = (line) => line.replace(/\x1b\[[0-9;]*m/gu, "");
    const frames = [
      { ...initialState, index: 0 },                            // top, first row
      { ...initialState, index: GROUPS.length - 1 },            // top, Danger zone selected
      { ...initialState, group: 8, index: 0 },                  // inside Danger zone
      { ...initialState, group: 2, index: 4 },                  // an item with a Current: line
      { ...initialState, search: { query: "key", index: 1 } },  // the search level
    ];
    for (const state of frames) {
      const options = { context: { kill: "tenant clear · platform clear" } };
      const plain = render(state, { ...options, colour: false });
      const painted = render(state, { ...options, colour: true }).map(strip);
      expect(painted).toEqual(plain);
    }
  });

  it("groups the top level into sections without making them selectable", () => {
    // The sections are drawn, not navigated: adding them must not move a single
    // index, or every keystroke count in the pty tests silently means something
    // else. The reducer is the authority on that, so ask it.
    const lines = render(initialState, { colour: false });
    for (const section of ["CONTROL", "AUDIT", "SYSTEM"]) {
      expect(lines).toContain(`  ${section}`);
    }
    let state = initialState;
    for (let i = 0; i < 3; i++) state = reduce(state, "down");
    expect(state.index).toBe(3);
    expect(reduce(state, "enter").group).toBe(3);
    expect(GROUPS[3].title).toBe("Money");
  });

  it("fits every frame into an 80x24 terminal", () => {
    // `browse` writes the frame after \x1b[2J\x1b[H and terminates it with a
    // newline, so N lines leave the cursor on row N+1 — at 24 lines a 24-row
    // terminal has already scrolled the title away, on every single keystroke.
    // That failure looks like a torn frame rather than like a layout bug, and
    // nothing else in this suite measures height, so it is measured here.
    //
    // The header is passed at its worst case: the title plus six status rows,
    // which is what `menuHeader` draws when the kill switch is armed. Every
    // group and every item is swept, because the tallest frame is not the one
    // you would guess — it is a six-item group whose selected entry also has a
    // "Current:" line, and adding either a group entry or a detail row is
    // exactly the kind of change that would quietly overflow it.
    const header = ["PassControl 0.0.0", "a", "b", "c", "d", "e", "f"].join("\n");
    const context = Object.fromEntries(
      ["account", "config", "provider", "app", "key", "gateway", "fleet", "kill"].map((k) => [k, "set"])
    );
    const height = (state, extra = {}) =>
      render(state, { colour: false, header, context, ...extra }).join("\n").split("\n").length;

    expect(height(initialState)).toBeLessThanOrEqual(23);
    for (let group = 0; group < GROUPS.length; group++) {
      for (let index = 0; index < GROUPS[group].items.length; index++) {
        const frame = height({ ...initialState, group, index });
        expect(frame, `${GROUPS[group].title} / ${GROUPS[group].items[index].label}`).toBeLessThanOrEqual(23);
        // Height was measured here for years; WIDTH was not, and `render`
        // neither wraps nor truncates. A line past 80 columns wraps in the
        // terminal and adds rows this sweep cannot see — the same torn frame,
        // arrived at sideways. A 154-column description slipped in that way.
        //
        // The bound is 86, not 80, because six rows already sit between the
        // two: `key-migrate`, three Danger-zone descriptions and the reset
        // detail line. Each wraps by a few characters into one extra row, which
        // the 23-line budget absorbs. This pins that as the ceiling rather than
        // blessing it — a new row must not be the worst one — and tightening it
        // to 80 means rewording those six, which is worth doing separately.
        for (const line of render({ ...initialState, group, index }, { colour: false, header, context })) {
          for (const wrapped of line.split("\n")) {
            expect(
              wrapped.length,
              `${GROUPS[group].title} / ${GROUPS[group].items[index].label}: line over 86 columns`
            ).toBeLessThanOrEqual(86);
          }
        }
      }
    }
    // The search level windows its results, and `browse` sizes that window as
    // rows − SEARCH_CHROME_LINES. If the constant under-counts the chrome the
    // window is too tall and the frame overflows exactly as the others would.
    expect(height(
      { ...initialState, search: { query: "a", index: 0 } },
      { maxResults: 24 - SEARCH_CHROME_LINES }
    )).toBeLessThanOrEqual(23);
  });

  it("renders filtered search results and their detail", () => {
    const lines = render(
      { ...initialState, search: { query: "receipt", index: 0 } },
      { colour: false }
    ).join("\n");
    expect(lines).toContain("Search: receipt");
    expect(lines).toContain("Verify a signed receipt");
    expect(lines).toContain("passcontrol verify receipt <jws>");
  });

  it("ranks a row NAMED for the query above one that merely mentions it", () => {
    // The property the assertion above was silently relying on. An unranked
    // filter returns group order, so a row whose DESCRIPTION contains the word
    // can outrank the row that is the word — which is what happened when
    // "Signed spend statements" (whose description explains it commits to every
    // receipt) landed above "Verify a signed receipt" for the query "receipt".
    const results = searchMenu("receipt");
    expect(results.length).toBeGreaterThan(1);
    const named = (item) => `${item.label} ${item.detail}`.toLowerCase().includes("receipt");
    expect(named(results[0])).toBe(true);
    // Description-only matches are still returned, just after.
    expect(results.some((item) => !named(item))).toBe(true);
    // Stable within a tier: group order is unchanged for equally-ranked rows.
    const all = searchMenu("");
    const order = (item) => all.indexOf(item);
    const tier = results.filter(named);
    expect([...tier].sort((a, b) => order(a) - order(b))).toEqual(tier);
  });
});

describe("the non-terminal fallback", () => {
  it("prints every command rather than failing", () => {
    let out = "";
    printStatic((text) => { out += text; });
    for (const group of GROUPS) {
      expect(out).toContain(group.title);
      for (const item of group.items) expect(out).toContain(`passcontrol ${item.detail}`);
    }
  });
});

/** A stdin that claims to be a TTY and records whether raw mode was left on. */
function fakeTty() {
  const stream = new EventEmitter();
  stream.isTTY = true;
  stream.raw = false;
  stream.setRawMode = (on) => { stream.raw = on; return stream; };
  stream.resume = () => stream;
  stream.pause = () => stream;
  stream.setEncoding = () => stream;
  stream.off = (name, fn) => { stream.removeListener(name, fn); return stream; };
  return stream;
}

describe("the driver restores the terminal", () => {
  const sink = () => {
    const written = [];
    return { isTTY: true, write: (text) => { written.push(text); return true; }, written };
  };

  it("acts on every key in a coalesced chunk", async () => {
    const stdin = fakeTty();
    const promise = browse({ stdin, stdout: sink() });
    // Four downs, open, then choose — all in one delivery, as a held arrow key
    // followed by a quick return produces. Before the buffer was tokenised
    // this landed on the first group's first item instead.
    stdin.emit("data", "\x1b[B\x1b[B\x1b[B\x1b[B\r\r");
    await expect(promise).resolves.toEqual(GROUPS[4].items[0]);
    expect(stdin.raw).toBe(false);
  });

  it("ignores keys typed after the selection", async () => {
    // Whatever follows the choice belongs to the command about to run, not to
    // a menu that is already gone.
    const stdin = fakeTty();
    const promise = browse({ stdin, stdout: sink() });
    stdin.emit("data", "\r\rqqq");
    await expect(promise).resolves.toEqual(GROUPS[0].items[0]);
  });

  it("leaves raw mode off after a selection", async () => {
    const stdin = fakeTty();
    const stdout = sink();
    const promise = browse({ stdin, stdout });
    expect(stdin.raw, "raw mode should be on while the menu is up").toBe(true);
    stdin.emit("data", "\r");        // open the first group
    stdin.emit("data", "\r");        // choose its first item
    const chosen = await promise;
    expect(chosen).toEqual(GROUPS[0].items[0]);
    // The load-bearing assertion: a menu that exits without restoring raw mode
    // leaves the user's shell with no echo, which reads as a hung machine.
    expect(stdin.raw).toBe(false);
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("leaves raw mode off after Ctrl-C, and resolves null", async () => {
    const stdin = fakeTty();
    const promise = browse({ stdin, stdout: sink() });
    stdin.emit("data", "\x03");
    await expect(promise).resolves.toBeNull();
    expect(stdin.raw).toBe(false);
  });

  it("restores the cursor on the way out", async () => {
    const stdin = fakeTty();
    const stdout = sink();
    const promise = browse({ stdin, stdout });
    stdin.emit("data", "q");
    await promise;
    expect(stdout.written.join("")).toContain("\x1b[?25h");
  });

  it("draws immediately and refreshes when asynchronous status arrives", async () => {
    const stdin = fakeTty();
    const stdout = sink();
    let resolveStatus;
    const status = new Promise((resolve) => { resolveStatus = resolve; });
    const promise = browse({
      stdin,
      stdout,
      status,
      header: (remote) => remote ? `fleet ${remote.fleet}` : "checking",
    });
    expect(stdout.written.join("")).toContain("checking");
    resolveStatus({ fleet: "2 agents", current: { fleet: "2 agents" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(stdout.written.join("")).toContain("fleet 2 agents");
    stdin.emit("data", "q");
    await promise;
  });

  it("restores raw mode when rendering throws", async () => {
    const stdin = fakeTty();
    const stdout = { isTTY: true, write: () => { throw new Error("gone"); } };
    await expect(browse({ stdin, stdout })).rejects.toThrow("gone");
    expect(stdin.raw).toBe(false);
    expect(stdin.listenerCount("data")).toBe(0);
  });
});
