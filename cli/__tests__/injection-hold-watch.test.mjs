import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createWatchFeed } from "../watch-feed.mjs";
import { applyEvent, createBoardState, plainLine, renderBoard } from "../watch.mjs";

describe("local tool holds", () => {
  it.each(["approved", "denied", "timeout", "unavailable", "through"])("replays and renders %s without counting a call or leaking input", (outcome) => {
    const feed = createWatchFeed({ runId: "r", now: () => 123 });
    feed.toolHold({ at: 123, tool: "Bash", outcome, tool_input: "SECRET", text: "SECRET" });
    const events = [];
    const res = new EventEmitter(); res.write = (line) => events.push(JSON.parse(line));
    feed.attach(res);
    expect(events[1]).toEqual({ type: "tool_hold", seq: 1, at: 123, tool: "Bash", outcome });
    const state = createBoardState();
    for (const event of events) applyEvent(state, { ...event, text: "SECRET" });
    expect(plainLine(state.rows[0], {})).toContain(`  HELD · injection guard · Bash · ${outcome}`);
    const rows = renderBoard(state, { width: 120, height: 10, port: 8788, color: true });
    expect(rows[0]).toContain("no calls yet");
    expect(rows.join("\n")).toContain("\x1b[33m");
    expect(JSON.stringify(state)).not.toContain("SECRET");
  });
  it("rejects invalid outcomes and sanitizes tool names", () => {
    const state = createBoardState();
    applyEvent(state, { type: "tool_hold", seq: 1, outcome: "bogus" });
    expect(state.rows).toHaveLength(0);
    applyEvent(state, { type: "tool_hold", seq: 2, outcome: "denied", tool: "Bash\x1b[2J" });
    expect(state.rows[0].tool).toBeNull();
  });
});
