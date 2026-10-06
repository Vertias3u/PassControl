// 1.0.0 known issue: `setup --port-offset N` moved Supabase and Redis but left
// the dashboard on :3000, so a second install collided with the first one's
// dashboard. The dashboard moves with the offset, and setup hands that port to
// the stack script (Supabase's site URL and the receipt issuer read PORT).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dashboardOriginForOffset, portHolders, stackPortConflictMessage, stackProjectFromContainer } from "../local-stack.mjs";

describe("dashboardOriginForOffset", () => {
  it("is the canonical :3000 with no offset, and moves with one", () => {
    expect(dashboardOriginForOffset(0)).toBe("http://localhost:3000");
    expect(dashboardOriginForOffset(500)).toBe("http://localhost:3500");
  });

  it("refuses an offset setup would refuse", () => {
    for (const bad of [-1, 10001, 1.5, Number.NaN]) expect(() => dashboardOriginForOffset(bad)).toThrow();
  });
});

describe("setup", () => {
  const source = readFileSync(new URL("../../bin/passcontrol.mjs", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("async function setupLocal"), source.indexOf("async function initCommand"));

  it("targets the offset dashboard and gives the stack script its port", () => {
    expect(body).toContain("dashboardOriginForOffset(offset)");
    expect(body).not.toContain("canonicalLocalDashboard()");
    expect(body).toMatch(/PORT: String\(dashboard\.port\)/);
  });
});

// Found by the first real `passcontrol update` (1.0.0 → 1.1.0, 2026-10-03): a
// second stack on the same ports (the developer's own checkout, Supabase
// project "PassControl") held 54322. The update had already fast-forwarded and
// reinstalled before Supabase refused, and all it said was "npm exited with
// code 1". The refusal now comes first and names the stack holding the ports.
describe("portHolders", () => {
  const ps = [
    "supabase_db_PassControl\t0.0.0.0:54322->5432/tcp, [::]:54322->5432/tcp",
    "supabase_kong_PassControl\t0.0.0.0:54321->8000/tcp, [::]:54321->8000/tcp",
    "supabase_inbucket_PassControl\t0.0.0.0:54325->1025/tcp, 0.0.0.0:54324->8025/tcp",
    "supabase_edge_runtime_PassControl\t",
    "passcontrol_passcontrol-srh-1\t127.0.0.1:8079->80/tcp",
    "unrelated\t0.0.0.0:543220->1/tcp",
  ].join("\n");

  it("names the Supabase project behind each busy port", () => {
    expect(portHolders(ps, [54321, 54322])).toEqual([
      { container: "supabase_db_PassControl", project: "PassControl", ports: [54322] },
      { container: "supabase_kong_PassControl", project: "PassControl", ports: [54321] },
    ]);
  });

  it("keeps a container that is not a Supabase service by its name", () => {
    expect(portHolders(ps, [8079])).toEqual([{ container: "passcontrol_passcontrol-srh-1", project: null, ports: [8079] }]);
  });

  it("matches a port exactly, never as a prefix of a longer one", () => {
    expect(portHolders("unrelated\t0.0.0.0:543220->1/tcp", [54322])).toEqual([]);
  });

  it("reads a project whose name has underscores, after a service name that has one too", () => {
    expect(stackProjectFromContainer("supabase_edge_runtime_my_app")).toBe("my_app");
    expect(stackProjectFromContainer("supabase_db_my_app-500")).toBe("my_app-500");
    expect(stackProjectFromContainer("postgres")).toBeNull();
  });
});

describe("stackPortConflictMessage", () => {
  it("names the stack, the exact stop command, and that its data is kept", () => {
    const text = stackPortConflictMessage({
      busy: [54321, 54322],
      holders: [{ container: "supabase_db_PassControl", project: "PassControl", ports: [54322] }],
      rerun: "passcontrol update",
    });
    expect(text).toContain("54321, 54322");
    expect(text).toContain('project "PassControl"');
    expect(text).toContain("`supabase stop --project-id PassControl`");
    expect(text).toMatch(/data is kept/);
    expect(text).toMatch(/Stop it first/);
    expect(text).toContain("rerun `passcontrol update`");
  });

  it("gives a container outside Supabase (the Redis bridge) its own stop command", () => {
    const text = stackPortConflictMessage({
      busy: [54322, 8079],
      holders: [
        { container: "supabase_db_PassControl", project: "PassControl", ports: [54322] },
        { container: "passcontrol_passcontrol-srh-1", project: null, ports: [8079] },
      ],
      rerun: "passcontrol update",
    });
    expect(text).toContain("`supabase stop --project-id PassControl` and `docker stop passcontrol_passcontrol-srh-1`");
    expect(text).toMatch(/Stop them first/);
  });

  it("falls back to a generic line when nothing could be identified", () => {
    const text = stackPortConflictMessage({ busy: [54322], holders: [], rerun: "passcontrol setup" });
    expect(text).toContain("another program or project");
    expect(text).toContain("supabase stop --project-id <project>");
    expect(text).toContain("rerun `passcontrol setup`");
  });
});
