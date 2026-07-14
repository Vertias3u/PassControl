import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const MCP_INTEGRATIONS = new Set(["claude-desktop", "cursor", "claude-code"]);
export const CLAUDE_CODE_ADD_COMMAND =
  "claude mcp add --scope user passcontrol -- passcontrol mcp";

export function isMcpIntegration(name) {
  return MCP_INTEGRATIONS.has(name);
}

export function mcpServerEntry({ cliPath, nodePath = process.execPath }) {
  return {
    command: path.resolve(nodePath),
    args: [path.resolve(cliPath), "mcp"],
  };
}

export function mcpServersDocument(entry) {
  return { mcpServers: { passcontrol: entry } };
}

export function mcpClientConfigPath(
  integration,
  { platform = process.platform, home = os.homedir(), env = process.env } = {}
) {
  if (integration === "cursor") return path.join(home, ".cursor", "mcp.json");
  if (integration !== "claude-desktop") return null;

  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (platform === "win32") {
    const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  const configHome = env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(configHome, "Claude", "claude_desktop_config.json");
}

function readConfigObject(target) {
  if (!fs.existsSync(target)) return { exists: false, value: {} };

  let value;
  try {
    value = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse ${target}: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${target} must contain a JSON object.`);
  }
  if (
    value.mcpServers !== undefined &&
    (!value.mcpServers || typeof value.mcpServers !== "object" || Array.isArray(value.mcpServers))
  ) {
    throw new Error(`${target} has an invalid mcpServers value; expected a JSON object.`);
  }
  return { exists: true, value };
}

export function writeMcpClientConfig({ target, entry, force = false }) {
  const { exists, value } = readConfigObject(target);
  const mcpServers = value.mcpServers ?? {};
  const hasPassControl = Object.prototype.hasOwnProperty.call(mcpServers, "passcontrol");
  if (hasPassControl && !isDeepStrictEqual(mcpServers.passcontrol, entry) && !force) {
    throw new Error(
      `${target} already has a different mcpServers.passcontrol entry; re-run with --force to replace only that entry.`
    );
  }
  if (hasPassControl && isDeepStrictEqual(mcpServers.passcontrol, entry)) {
    return { changed: false, backupPath: null };
  }

  const merged = {
    ...value,
    mcpServers: {
      ...mcpServers,
      passcontrol: entry,
    },
  };
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });

  let backupPath = null;
  if (exists) {
    backupPath = `${target}.bak`;
    fs.copyFileSync(target, backupPath);
    fs.chmodSync(backupPath, 0o600);
  }

  fs.writeFileSync(target, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  return { changed: true, backupPath };
}
