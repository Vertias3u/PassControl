// The per-service stop on the Services page. It shows what was observed: an
// unreadable state is never drawn as running or stopped, and what it says about
// an unreadable state depends on the deployment's posture.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/dashboard/service-actions", () => ({ setServiceKill: vi.fn(), observeServiceKillAction: vi.fn() }));
const { ServiceStopControl, serviceStopPhase } = await import("@/components/ServiceStopControl");

const render = (initialStopped: boolean | null, failClosed = false) =>
  renderToStaticMarkup(
    <ServiceStopControl service="github" serviceLabel="GitHub" initialStopped={initialStopped} failClosed={failClosed} />
  );

describe("ServiceStopControl", () => {
  it("draws running, stopped and unreadable as three different states", () => {
    expect(render(false)).toContain('data-service-stop="running"');
    expect(render(false)).toContain('data-action="stop-service"');
    expect(render(true)).toContain('data-service-stop="stopped"');
    expect(render(true)).toContain('data-action="resume-service"');
    expect(render(true)).toMatch(/Model calls are not affected/);
    const unknown = render(null);
    expect(unknown).toContain('data-service-stop="unknown"');
    expect(unknown).toContain('data-action="refresh-service-stop"');
  });

  it("describes an unreadable stop by what this deployment does about it", () => {
    expect(render(null, true)).toMatch(/refuses every call until it can/);
    expect(render(null, false)).toMatch(/lets GitHub calls through their rules/);
  });

  it("names work in progress from the intent, and a lost answer as unconfirmed", () => {
    expect(serviceStopPhase({ busy: { kind: "apply", next: true }, stopped: false, unconfirmed: false })).toBe("stopping");
    expect(serviceStopPhase({ busy: null, stopped: false, unconfirmed: true })).toBe("unconfirmed");
  });
});
