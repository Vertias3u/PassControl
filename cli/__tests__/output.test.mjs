import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatLabel, heading, ok, step } from "../config.mjs";

const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const originalCI = process.env.CI;
const originalNoColor = process.env.NO_COLOR;

beforeEach(() => {
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: true,
  });
  delete process.env.CI;
  delete process.env.NO_COLOR;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalIsTTY) Object.defineProperty(process.stdout, "isTTY", originalIsTTY);
  else delete process.stdout.isTTY;
  if (originalCI === undefined) delete process.env.CI;
  else process.env.CI = originalCI;
  if (originalNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = originalNoColor;
});

describe("CLI presentation helpers", () => {
  it("styles headings, aligned labels, and progress marks in an interactive terminal", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(heading("PassControl")).toBe("\x1b[1;32mPassControl\x1b[0m");
    expect(formatLabel("Gateway", "online")).toBe(
      "\x1b[36mGateway:   \x1b[0monline"
    );
    step("checking gateway");
    ok("ready");

    expect(log).toHaveBeenNthCalledWith(1, "\x1b[36m→\x1b[0m checking gateway");
    expect(log).toHaveBeenNthCalledWith(2, "\x1b[32m✓\x1b[0m ready");
  });

  it.each([
    ["when NO_COLOR is set", () => { process.env.NO_COLOR = "1"; }],
    ["when stdout is not a TTY", () => {
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: false,
      });
    }],
    ["under CI", () => { process.env.CI = "1"; }],
  ])("disables ANSI %s", (_label, disableColor) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    disableColor();

    const output = [heading("PassControl"), formatLabel("Gateway", "online")];
    step("checking gateway");
    ok("ready");
    output.push(...log.mock.calls.flat());

    expect(output.join("\n")).not.toMatch(/\x1b\[/);
  });
});
