import { afterEach, describe, expect, it, vi } from "vitest";
import { isSentryConfigured, logFailOpen, scrubSentryEvent } from "@/lib/observability";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Sentry observability scrubber", () => {
  it("emits a fixed operational warning for a fail-open read", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logFailOpen("kill_read");

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("[passcontrol:fail_open] kill_read");
  });

  it("is disabled when SENTRY_DSN is unset", () => {
    const before = process.env.SENTRY_DSN;
    delete process.env.SENTRY_DSN;
    try {
      expect(isSentryConfigured()).toBe(false);
    } finally {
      if (before === undefined) delete process.env.SENTRY_DSN;
      else process.env.SENTRY_DSN = before;
    }
  });

  it("strips request/response bodies, headers, cookies, breadcrumbs, and secret-shaped values", () => {
    const rawEvent = {
      message: "upstream failed with sk-ant-secret and Bearer eyJhbGciOiJIUzI1NiJ9.secret.sig",
      request: {
        url: "https://example.test/api/v1/anthropic/v1/messages",
        headers: {
          authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.secret.sig",
          cookie: "sb-access-token=secret",
        },
        data: { prompt: "user body must not leave the gateway" },
        cookies: "session=secret",
      },
      breadcrumbs: [{ message: "raw request body leaked here" }],
      extra: {
        providerKey: "sk-ant-provider-key",
        responseBody: "provider response body",
        serviceRoleKey: "eyJservice.role.secret",
      },
      tags: {
        route: "api.proxy",
        provider: "anthropic",
        authorization: "Bearer secret",
        apiKey: "pc_secret",
      },
      contexts: {
        passcontrol: {
          route: "api.proxy",
          status: 502,
          provider: "anthropic",
          agentId: "agent_123",
          jti: "jti_123",
          requestId: "req_123",
          requestBody: "prompt body",
          visa: "eyJhbGciOiJIUzI1NiJ9.secret.sig",
        },
      },
    };

    const scrubbed = scrubSentryEvent(rawEvent);
    const asJson = JSON.stringify(scrubbed);

    expect(scrubbed.request).toBeUndefined();
    expect(scrubbed.breadcrumbs).toBeUndefined();
    expect(scrubbed.extra).toBeUndefined();
    expect(scrubbed.tags).toEqual({ route: "api.proxy", provider: "anthropic" });
    expect(scrubbed.contexts).toEqual({
      passcontrol: {
        route: "api.proxy",
        status: 502,
        provider: "anthropic",
        agentId: "agent_123",
        jti: "jti_123",
        requestId: "req_123",
      },
    });
    expect(asJson).not.toContain("sk-ant");
    expect(asJson).not.toContain("Bearer");
    expect(asJson).not.toContain("user body must not leave");
    expect(asJson).not.toContain("provider response body");
    expect(asJson).not.toContain("service.role.secret");
    expect(asJson).not.toContain("prompt body");
  });
});
