// Review 2026-11-21 finding 5: the browser approval screen looked the same for a
// one-command key (15 minutes, fixed life) and a machine login (a write key valid until
// revoked), and the only label on it was the device name the REQUESTER chose. An agent
// that can run the device flow itself could name its own machine login
// "one command - kill off - <host>" and an owner used to one-command prompts would see
// nothing telling them apart. The kind must come from the server's record of the
// request, and the screen must say it in words, not in the requester's words.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeviceApprovalNotice } from "@/components/DeviceApprovalNotice";

const actions = readFileSync(join(process.cwd(), "app/dashboard/actions.ts"), "utf8");
const screen = readFileSync(join(process.cwd(), "components/CliDeviceApproval.tsx"), "utf8");

function inspectBody(): string {
  const start = actions.search(/^async function inspectCliDeviceBody\b/m);
  expect(start).toBeGreaterThan(-1);
  const rest = actions.slice(start + 1);
  return rest.slice(0, rest.search(/^(?:export )?async function \w/m));
}

describe("the approval screen says which kind of key it mints", () => {
  it("the inspect read returns the kind from the server's pending record", () => {
    expect(inspectBody()).toMatch(/oneCommand:\s*found\.pending\.oneCommand\s*===\s*true/u);
  });

  it("the confirm stage renders the server-decided kind, not only the device name", () => {
    expect(screen).toMatch(/<DeviceApprovalNotice[^>]*oneCommand=\{stage\.oneCommand\}/u);
  });

  it("a one-command approval says one command and 15 minutes, and never 'until you revoke it'", () => {
    const html = renderToStaticMarkup(<DeviceApprovalNotice oneCommand oneCommandMinutes={15} />);
    expect(html).toContain('data-kind="one-command"');
    expect(html).toMatch(/one command/iu);
    expect(html).toContain("15 minutes");
    expect(html).not.toMatch(/until you revoke it/iu);
  });

  it("a machine login says so, says it lasts until revoked, and warns that the name is not the kind", () => {
    const html = renderToStaticMarkup(<DeviceApprovalNotice oneCommand={false} />);
    expect(html).toContain('data-kind="machine-login"');
    expect(html).toMatch(/machine login/iu);
    expect(html).toMatch(/until you revoke it/iu);
    expect(html).toMatch(/not a one-command approval/iu);
  });
});
