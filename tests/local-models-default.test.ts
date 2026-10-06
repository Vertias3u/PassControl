// Local models, item 1: on the local stack, custom endpoints are on unless the
// developer turned them off.
//
// Self-host is one developer on their own machine (localhost:3000). The person
// who can set an endpoint in Settings is the person who owns the gateway, so
// the off-by-default gate, which exists to stop a TENANT pointing a shared
// gateway at its host's network, only got in the way of pointing it at Ollama.
// The default moves in the local-stack LAUNCHER, never in code: Cloud runs
// `next build` on Vercel, never scripts/dev-docker.mjs, and relies on
// endpointPolicy() reading unset as off.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { localStackEnv, parseEnvFile } from "../scripts/dev-docker.mjs";
import { endpointPolicy } from "@/lib/providers/endpoint";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("the local stack's custom-endpoint default", () => {
  it("is selfhost when neither the file nor the shell sets it", () => {
    const env = localStackEnv(parseEnvFile("VISA_SECRET=x\n"), {});
    expect(env.PROVIDER_ENDPOINT_MODE).toBe("selfhost");
    expect(env.VISA_SECRET).toBe("x");
  });

  it("keeps an explicit off in the file", () => {
    const env = localStackEnv(parseEnvFile("PROVIDER_ENDPOINT_MODE=off\n"), {});
    expect(env.PROVIDER_ENDPOINT_MODE).toBe("off");
  });

  it("keeps an explicit empty value in the file, which reads as off", () => {
    const env = localStackEnv(parseEnvFile("PROVIDER_ENDPOINT_MODE=\n"), {});
    expect(env.PROVIDER_ENDPOINT_MODE).toBe("");
  });

  it("does not overwrite a value the shell already set when the file is silent", () => {
    // `PROVIDER_ENDPOINT_MODE=off npm run dev:docker` must still mean off.
    const env = localStackEnv(parseEnvFile("VISA_SECRET=x\n"), { PROVIDER_ENDPOINT_MODE: "off" });
    expect(env).not.toHaveProperty("PROVIDER_ENDPOINT_MODE");
  });

  it("keeps an allowlist from the file untouched", () => {
    const env = localStackEnv(parseEnvFile("PROVIDER_ENDPOINT_MODE=models.internal\n"), {});
    expect(env.PROVIDER_ENDPOINT_MODE).toBe("models.internal");
  });

  it("is what the launcher applies to the process environment", () => {
    expect(read("scripts/dev-docker.mjs")).toContain(
      "Object.assign(process.env, localStackEnv(parseEnvFile("
    );
  });

  it("is written visibly into a newly generated .env.docker", () => {
    expect(read("scripts/dev-stack.sh")).toMatch(/^PROVIDER_ENDPOINT_MODE=selfhost$/m);
  });

  it("is declared for type-checking, since the declaration ships to the mirror", () => {
    expect(read("scripts/dev-docker.d.mts")).toContain("export declare function localStackEnv(");
  });
});

describe("the code default stays off", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads an unset mode as off, which is what Cloud runs on", () => {
    vi.stubEnv("PROVIDER_ENDPOINT_MODE", "");
    expect(endpointPolicy()).toEqual({ kind: "off" });
  });

  it("documents off in .env.example, the template a hosted deployment starts from", () => {
    expect(read(".env.example")).toMatch(/^PROVIDER_ENDPOINT_MODE=off$/m);
  });
});
