import { describe, expect, it, vi } from "vitest";
import { deliverBetaFollowup } from "@/lib/beta-followup";

function harness(overrides: {
  issuer?: string;
  delivery?: { ok: boolean } | Error;
  transitionError?: Error | null;
  reserveError?: { code?: string } | null;
} = {}) {
  const reserve = vi.fn(async () => ({
    id: overrides.reserveError ? null : "event-1",
    error: overrides.reserveError ?? null,
  }));
  const transition = vi.fn(async () => ({ error: overrides.transitionError ?? null }));
  const send = vi.fn(async () => {
    if (overrides.delivery instanceof Error) throw overrides.delivery;
    return overrides.delivery ?? { ok: true };
  });
  return {
    reserve,
    transition,
    send,
    run: () => deliverBetaFollowup({
      kind: "nudge",
      issuer: overrides.issuer ?? "https://passcontrol.example/",
      to: "invitee@example.test",
      applicationId: "application-1",
      reserve,
      transition,
      send,
    }),
  };
}

describe("beta follow-up delivery state", () => {
  it("validates the issuer and builds the email before reserving delivery", async () => {
    const h = harness({ issuer: "" });

    await expect(h.run()).resolves.toEqual({ code: "origin_unavailable" });
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("reserves a pending event and records sent only after provider acceptance", async () => {
    const h = harness();

    await expect(h.run()).resolves.toEqual({ code: "sent" });
    expect(h.reserve).toHaveBeenCalledWith("nudge.pending");
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "beta-nudge/application-1",
      to: "invitee@example.test",
    }));
    expect(h.transition).toHaveBeenCalledWith("event-1", "nudge.sent");
  });

  it("records a provider refusal as failed so the operator can retry", async () => {
    const h = harness({ delivery: { ok: false } });

    await expect(h.run()).resolves.toEqual({ code: "delivery_failed" });
    expect(h.transition).toHaveBeenCalledWith("event-1", "nudge.send_failed");
  });

  it("never describes a failed delivery as retryable when its state could not be settled", async () => {
    const h = harness({ delivery: { ok: false }, transitionError: new Error("db down") });

    await expect(h.run()).resolves.toEqual({ code: "delivery_state_unresolved" });
  });

  it("keeps an accepted-but-unrecorded delivery explicitly unresolved", async () => {
    const h = harness({ transitionError: new Error("db down") });

    await expect(h.run()).resolves.toEqual({ code: "accepted_state_unresolved" });
  });

  it("settles a thrown provider call as a failed delivery", async () => {
    const h = harness({ delivery: new Error("network down") });

    await expect(h.run()).resolves.toEqual({ code: "delivery_failed" });
    expect(h.transition).toHaveBeenCalledWith("event-1", "nudge.send_failed");
  });

  it("does not send when a pending or sent delivery already owns the reservation", async () => {
    const h = harness({ reserveError: { code: "23505" } });

    await expect(h.run()).resolves.toEqual({ code: "already_reserved" });
    expect(h.send).not.toHaveBeenCalled();
  });
});
