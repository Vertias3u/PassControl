import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { zoomViewAtPoint } from "@/components/dashboard/ControlGraph";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const page = read("app/dashboard/graph/page.tsx");
const component = read("components/dashboard/ControlGraph.tsx");
const shell = read("components/dashboard/DashboardShell.tsx");
const homepage = read("components/PassControlSiteClient.tsx");
const homeCss = read("app/home.module.css");
const globalCss = read("app/globals.css");

describe("authenticated Control Graph composition", () => {
  it("uses the same auth and MFA navigation gates as the Control Tower", () => {
    expect(page).toContain('if (!user) redirect("/login")');
    expect(page).toContain('needsMfaStepUp(db)) redirect("/login/verify")');
    expect(shell).toContain('{ id: "graph", label: "Control graph", href: "/dashboard/graph"');
  });

  it("uses bounded owner reads and never imports the service-role client", () => {
    expect(page).not.toContain("serviceClient");
    expect(page).toMatch(/from\("agents"\)[\s\S]{0,300}eq\("user_id", user\.id\)[\s\S]{0,120}limit\(AGENT_LIMIT\)/);
    expect(page).toMatch(/from\("agent_logs"\)[\s\S]{0,500}eq\("user_id", user\.id\)[\s\S]{0,120}limit\(LOG_LIMIT\)/);
    expect(page).toMatch(/from\("break_glass_grants"\)[\s\S]{0,300}eq\("user_id", user\.id\)/);
    expect(page).not.toMatch(/vault_secret_id|key_hash|decrypted_secret/);
  });

  it("pins realtime to the authenticated tenant and animates only inserted rows", () => {
    expect(component).toContain('event: "INSERT"');
    expect(component).toContain('filter: `user_id=eq.${userId}`');
    expect(component).toContain("setActiveEvent((current)");
    expect(component).toContain("appendPresentationEventQueue");
    expect(component).not.toMatch(/initialSnapshot\.events[\s\S]{0,80}setActiveEvent/);
  });

  it("keeps historical calls stored-record only", () => {
    expect(page).toContain("The graph never reconstructs history with today's policy.");
    expect(component).toContain("<CallDetailDrawer");
    expect(component).toContain("receipt recorded");
    expect(component).toContain("break glass ·");
    expect(component).not.toMatch(/evaluate|trace-action|DecisionTracePanel/);
  });

  it("explains static routes and renders the real four-stage call path", () => {
    expect(component).toContain("Lines are possible routes—not calls.");
    expect(component).toContain("A moving dot appears only when a new stored call arrives.");
    expect(component).toContain("1 · AGENT ASKS");
    expect(component).toContain("2 · CONTROLS CHECK");
    expect(component).toContain("3 · KEY USED HERE");
    expect(component).toContain("4 · PROVIDER");
    expect(component).toContain('event.stop === "credential" || event.stop === "provider" || event.stop === "receipt"');
    expect(component).toContain("The provider key is injected here and never sent back to the agent.");
  });

  it("provides presentation privacy, keyboard selection and reduced motion", () => {
    expect(component).toContain("presentationSnapshot(snapshot, presentationIdentity)");
    expect(component).toContain('data-presentation-identity={presentationIdentity}');
    expect(component).toContain("Show names");
    expect(component).toContain("Stored event");
    expect(component).toContain("Newly recorded");
    expect(component).toContain('tabIndex={0}');
    expect(component).toContain('event.key === "Enter" || event.key === " "');
    expect(component).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
    expect(globalCss).toContain(".pc-control-graph:fullscreen");
    expect(globalCss).toContain('aspect-ratio');
    expect(globalCss).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("keeps wheel zoom anchored beneath the cursor and disables canvas text selection", () => {
    const anchor = { x: 400, y: 300 };
    const before = { x: 100, y: 50, k: 1 };
    const world = {
      x: (anchor.x - before.x) / before.k,
      y: (anchor.y - before.y) / before.k,
    };
    const after = zoomViewAtPoint(before, anchor, 2);

    expect(after.x + world.x * after.k).toBe(anchor.x);
    expect(after.y + world.y * after.k).toBe(anchor.y);
    expect(component).toContain("event.currentTarget.setPointerCapture(event.pointerId)");
    expect(component).not.toContain("event.target === event.currentTarget");
    expect(component).toContain("onPointerCancel={finishPointerInteraction}");
    expect(component).toMatch(/onPointerDown=\{\(event\) => \{[\s\S]{0,180}setSelectedNodeId\(node\.id\)/);
    expect(component).not.toMatch(/onPointerDown=\{\(event\) => \{[\s\S]{0,180}event\.preventDefault\(\);[\s\S]{0,180}dragRef\.current = node\.id/);
    expect(globalCss).toMatch(/\.pc-control-graph__canvas[^}]*user-select:\s*none/);
  });
});

describe("homepage boundary graph", () => {
  it("runs only from the existing real demo states and preserves the disclosure contract", () => {
    expect(homepage).toContain("function DemoBoundaryGraph");
    expect(homepage).toContain("Every signal below comes from the call you just made.");
    expect(homepage).toContain("<DemoBoundaryGraph state={state} />");
    expect(homepage).not.toMatch(/setInterval|synthetic|ambient/);
  });

  it("stops the blocked path at PassControl and has a reduced-motion fallback", () => {
    expect(homepage).toContain('blocked ? "Demo call stopped at PassControl"');
    expect(homepage).toContain('data-blocked={blocked}');
    expect(homeCss).toContain(".demoGraphPulse { display: none; }");
  });
});
