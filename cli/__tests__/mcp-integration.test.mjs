import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI = path.join(process.cwd(), "bin/passcontrol.mjs");
const SECRET = "global-passport-secret-marker";

let tmp = "";

function homePath() {
  return path.join(tmp, "home");
}

function cliEnv(extra = {}) {
  const home = homePath();
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    NODE_ENV: "test",
    XDG_CONFIG_HOME: path.join(home, ".config"),
    ...extra,
  };
}

async function runCli(args, { cwd = tmp, env = {} } = {}) {
  return execFileAsync(process.execPath, [CLI, ...args], {
    cwd,
    env: cliEnv(env),
    timeout: 10000,
  });
}

async function writeGlobalConfig({ secret = SECRET } = {}) {
  const file = path.join(homePath(), ".config", "passcontrol", "config");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    [
      "PASSCONTROL_GATEWAY=https://gateway.test",
      "PASSPORT_ID=global-passport-id",
      `PASSPORT_SECRET=${secret}`,
      "PROVIDER=anthropic",
      "MODEL=claude-haiku-4-5",
      "",
    ].join("\n"),
    { mode: 0o600 }
  );
  return file;
}

function claudeDesktopConfigPath() {
  if (process.platform === "darwin") {
    return path.join(homePath(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    return path.join(homePath(), "AppData", "Roaming", "Claude", "claude_desktop_config.json");
  }
  return path.join(homePath(), ".config", "Claude", "claude_desktop_config.json");
}

function parseJsonBlock(output) {
  return JSON.parse(output.slice(output.indexOf("{")));
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "passcontrol-mcp-integration-"));
  await fs.mkdir(homePath(), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("first-class MCP CLI integration", () => {
  it("starts passcontrol mcp using only the global profile", async () => {
    await writeGlobalConfig();
    const unrelatedCwd = path.join(tmp, "unrelated", "nested");
    await fs.mkdir(unrelatedCwd, { recursive: true });
    const client = new Client({ name: "global-config-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "mcp"],
      cwd: unrelatedCwd,
      stderr: "pipe",
      env: cliEnv(),
    });

    try {
      await client.connect(transport);
      const result = await client.listTools();
      expect(result.tools.map((tool) => tool.name).sort()).toEqual(["chat", "list_models"]);
    } finally {
      await client.close();
    }
  }, 10000);

  it("prints a secret-free absolute Claude Desktop mcpServers block", async () => {
    await writeGlobalConfig();

    const { stdout } = await runCli(["env", "claude-desktop"]);
    const block = parseJsonBlock(stdout);

    expect(block).toEqual({
      mcpServers: {
        passcontrol: {
          command: process.execPath,
          args: [CLI, "mcp"],
        },
      },
    });
    expect(path.isAbsolute(block.mcpServers.passcontrol.command)).toBe(true);
    expect(path.isAbsolute(block.mcpServers.passcontrol.args[0])).toBe(true);
    expect(stdout).not.toContain(SECRET);
    expect(block.mcpServers.passcontrol).not.toHaveProperty("env");
  });

  it.each([
    ["env", ["env", "claude-desktop"]],
    ["configure", ["configure", "claude-desktop", "--write"]],
  ])("guards %s when the global profile has no passport", async (_name, args) => {
    await expect(
      runCli(args, {
        env: {
          PASSPORT_ID: "environment-only-id",
          PASSPORT_SECRET: "environment-only-secret",
        },
      })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("passcontrol init --global"),
    });
  });

  it("merges Claude Desktop config, preserves existing keys, backs up, and writes no secret", async () => {
    await writeGlobalConfig();
    const target = claudeDesktopConfigPath();
    const existing = {
      theme: "dark",
      mcpServers: {
        existing: { command: "existing-server", args: ["serve"] },
      },
    };
    const original = `${JSON.stringify(existing, null, 2)}\n`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, original);

    await runCli(["configure", "claude-desktop", "--write"]);

    const mergedText = await fs.readFile(target, "utf8");
    const merged = JSON.parse(mergedText);
    expect(merged.theme).toBe("dark");
    expect(merged.mcpServers.existing).toEqual(existing.mcpServers.existing);
    expect(merged.mcpServers.passcontrol).toEqual({
      command: process.execPath,
      args: [CLI, "mcp"],
    });
    expect(await fs.readFile(`${target}.bak`, "utf8")).toBe(original);
    expect(mergedText).not.toContain(SECRET);
    expect(mergedText).not.toContain("PASSPORT_SECRET");
    if (process.platform !== "win32") {
      expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    }
  });

  it("refuses a different passcontrol entry unless --force is supplied", async () => {
    await writeGlobalConfig();
    const target = claudeDesktopConfigPath();
    const existing = {
      mcpServers: {
        passcontrol: { command: "custom-wrapper", args: [] },
        keep: { command: "keep-me" },
      },
    };
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(existing, null, 2)}\n`);

    await expect(
      runCli(["configure", "claude-desktop", "--write"])
    ).rejects.toMatchObject({ stderr: expect.stringContaining("--force") });
    expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual(existing);

    await runCli(["configure", "claude-desktop", "--write", "--force"]);
    const forced = JSON.parse(await fs.readFile(target, "utf8"));
    expect(forced.mcpServers.keep).toEqual(existing.mcpServers.keep);
    expect(forced.mcpServers.passcontrol).toEqual({
      command: process.execPath,
      args: [CLI, "mcp"],
    });
  });

  it("prints computed log totals and a dash when token data is absent", async () => {
    const server = http.createServer((request, response) => {
      expect(request.url).toBe("/api/control/v1/logs?limit=20");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: [
            {
              created_at: "2026-07-14T00:00:00Z",
              agent_id: "agent-with-tokens",
              provider: "openai",
              model: "gpt-4o-mini",
              status: "ok",
              input_tokens: 41,
              output_tokens: 1,
              cost_microcents: 0,
            },
            {
              created_at: "2026-07-14T00:00:01Z",
              agent_id: "agent-without-tokens",
              provider: "openai",
              model: "gpt-4o-mini",
              status: "blocked_scope",
              input_tokens: null,
              output_tokens: null,
              cost_microcents: 0,
            },
          ],
        })
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();

    try {
      const { stdout } = await runCli(["logs"], {
        env: {
          PASSCONTROL_GATEWAY: `http://127.0.0.1:${address.port}`,
          PASSCONTROL_API_KEY: "pc_test",
        },
      });
      const withTokens = stdout.split("\n").find((line) => line.includes("agent-with-tokens"));
      const withoutTokens = stdout.split("\n").find((line) => line.includes("agent-without-tokens"));
      expect(withTokens).toContain("42");
      expect(withoutTokens).toContain("-");
      expect(stdout).not.toContain("undefined");
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
