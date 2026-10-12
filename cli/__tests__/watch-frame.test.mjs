// What `passcontrol watch` writes to the terminal, read back through a terminal.
//
// Found in the owner's own 1.5.0 test (macOS Terminal, 2026-10-11): every row lost its
// last character ("LATENC", "99m"). Each line was exactly as wide as the window, and
// draw() follows each line with ESC[K. After a terminal writes the last column it
// holds the cursor ON that column (the pending-wrap state), and ESC[K erases from the
// cursor, so it erased the character just written. renderBoard was right; the frame
// around it was not. Only a terminal shows that, so this test runs the frame through
// a small one with xterm's rules for the few sequences the board uses.
import { describe, expect, it } from "vitest";

import { applyEvent, createBoardState, renderBoard, screenFrame } from "../watch.mjs";

/** The screen after `frame`: a grid of `rows` × `cols`, xterm semantics. */
function terminal(frame, { cols, rows }) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(" "));
  let r = 0;
  let c = 0;
  let wrapPending = false;
  for (let i = 0; i < frame.length; ) {
    if (frame[i] === "\x1b") {
      const m = /^\x1b\[([0-9;]*)([A-Za-z])/.exec(frame.slice(i));
      if (!m) throw new Error(`unknown escape at ${i}`);
      i += m[0].length;
      if (m[2] === "H") [r, c, wrapPending] = [0, 0, false];
      else if (m[2] === "K") {
        for (let x = c; x < cols; x++) grid[r][x] = " ";
        wrapPending = false;
      } else if (m[2] === "J") {
        for (let x = c; x < cols; x++) grid[r][x] = " ";
        for (let y = r + 1; y < rows; y++) grid[y].fill(" ");
      }
      continue; // SGR (m) and anything else: no effect on the cells.
    }
    const ch = frame[i++];
    if (ch === "\r") [c, wrapPending] = [0, false];
    else if (ch === "\n") [r, wrapPending] = [Math.min(rows - 1, r + 1), false];
    else {
      if (wrapPending) [r, c, wrapPending] = [Math.min(rows - 1, r + 1), 0, false];
      grid[r][c] = ch;
      if (c === cols - 1) wrapPending = true;
      else c++;
    }
  }
  return grid.map((row) => row.join("").trimEnd());
}

function busyBoard() {
  const state = createBoardState();
  applyEvent(state, { type: "hello", run: "r1" });
  for (let seq = 1; seq <= 4; seq++) {
    applyEvent(state, {
      type: "call", seq, at: Date.now(), ses: "s1", agent: "agent-with-a-long-name", provider: "anthropic",
      model: "claude-haiku-4-5", outcome: "allowed", status: 200, ttfb: 400, ms: 99_000 + seq, cost: 1780,
    });
  }
  return state;
}

describe("screenFrame", () => {
  for (const cols of [60, 80, 100, 132]) {
    it(`shows every character of every row at ${cols} columns`, () => {
      const state = busyBoard();
      const rows = 14;
      const shown = terminal(screenFrame(state, { columns: cols, rows, port: 8787, color: false }), { cols, rows });
      // What the board meant to show, at the width the frame says it uses.
      const meant = renderBoard(state, { width: cols - 1, height: rows, port: 8787, color: false }).map((l) => l.trimEnd());
      expect(shown).toEqual(meant);
      expect(shown.join("\n")).toContain("LATENCY");
    });
  }

  it("never writes a line as wide as the window", () => {
    const frame = screenFrame(busyBoard(), { columns: 80, rows: 14, port: 8787, color: true });
    const lines = frame.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\r\n");
    for (const line of lines) expect(line.length).toBeLessThan(80);
  });

  it("keeps the session column in a standard 80-column window", () => {
    const shown = terminal(screenFrame(busyBoard(), { columns: 80, rows: 14, port: 8787 }), { cols: 80, rows: 14 });
    expect(shown.join("\n")).toContain("SESSION");
  });
});
