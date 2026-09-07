# PassControl MCP server

`passcontrol mcp` starts a local stdio MCP server with `chat` and `list_models`.
It reads the same environment, nearest `.passcontrol`, and global
`~/.config/passcontrol/config` sources as the rest of the CLI. MCP client setup requires a
passport in the global profile so clients can launch from any working directory without
embedding a secret:

```sh
passcontrol init --global
```

The client receives neither the provider key nor the short-lived work visa. The
server signs locally and obtains the visa from the gateway and sends every model call through the configured
PassControl gateway.

## Claude Desktop

Preview or merge the entry into Claude Desktop's real per-OS config path:

```sh
passcontrol env claude-desktop
passcontrol configure claude-desktop --write
```

## Cursor

Preview or merge `mcpServers.passcontrol` into `~/.cursor/mcp.json`:

```sh
passcontrol env cursor
passcontrol configure cursor --write
```

## Claude Code

Claude Code manages this setting through its CLI. Either command below prints the exact
`claude mcp add` command to run:

```sh
passcontrol env claude-code
passcontrol configure claude-code
```

The equivalent private, user-scoped command is:

```sh
claude mcp add --scope user passcontrol -- passcontrol mcp
```

Desktop/Cursor entries use absolute Node and `bin/passcontrol.mjs` paths because GUI clients
may not inherit shell `PATH`. Existing `mcpServers` entries are preserved, an existing file is
backed up to `.bak`, and a different PassControl entry requires `--force`. No generated client
config contains a passport secret or provider key.


In 0.9.0 `chat` sends a bearer visa, without a sender proof. Required sender-proof mode
therefore refuses it; use off/observe for this client. `list_models` reads model patterns
from the visa scope, not a live upstream model catalog; a wildcard is not a callable model.
Providers: OpenAI, Anthropic, Groq, Mistral, Together, DeepSeek, and Gemini (OpenAI-compatible).
The global profile can use the CLI OS credential store (`passcontrol key status`) rather
than containing the Passport secret. Custody declarations do not prove storage.
