# Self-host help: when setup or a governed call gets stuck

Use this guide after `passcontrol setup`, or to check what you need before running it.
For the walkthrough, use [local setup in the tutorial](../TUTORIAL.md#the-other-path--run-the-gateway-yourself),
then [your first governed call](../TUTORIAL.md#3-your-first-governed-call-self-host-path).

## “I don't know what failed”

Start in the same terminal and directory where the problem occurred:

```sh
passcontrol status
passcontrol doctor
passcontrol local-logs
```

`status` separates the active API gateway from the CLI-managed local dashboard. They
can be different: a running local dashboard does not mean your agent uses it.
`doctor` reports gateway reachability, Passport/control-key configuration and database
migration information when your permissions allow it. `local-logs` reads the managed
dashboard log, not the provider's logs or the dashboard's governed call history.

For more diagnostics:

```sh
passcontrol doctor --deep
```

This checks local prerequisites, attempts operator system-health reads, and, if a
Passport is configured, attempts a visa, a keyless governed demo call and receipt
verification. Demo scope, demo availability and signing configuration affect that
result; a failed demo leg is not proof that a real-provider call cannot work. Restricted
system-health access is also different from an unreachable gateway.

## “Setup says a prerequisite is missing”

Install the tools for the OS where you run the CLI, then open a new terminal. All rows
need Git, a running Docker engine with Docker Compose, the Supabase CLI available as
`supabase`, and Node with npm.

| OS | What to check |
|---|---|
| Windows | Install Git for Windows with Git Bash, Docker Desktop, the Supabase CLI and Node. Run PassControl from PowerShell or cmd. The launcher locates a working Git Bash; installing a WSL distribution is not required for the PassControl bash launcher. Docker has its own engine requirements. |
| macOS | Install Git, Docker Desktop, the Supabase CLI and Node. The local stack uses `bash` on PATH. Start Docker before setup. |
| Linux | Install Git, Docker Engine with Compose (or Docker Desktop), the Supabase CLI and Node. The current user must be able to reach the Docker engine. The stack uses `bash` on PATH. |

Use **Node 22 or newer for the full stack**. This follows the committed dependencies:
[package.json](../package.json) declares Node 18+ for the CLI, but
[package-lock.json](../package-lock.json) locks a Supabase client requiring Node 20+
and Wrangler requiring Node 22+. The CLI prerequisite probe checks the lower CLI
minimum, so its “supported” result does not certify the full application build.

Check the tools that this terminal actually finds:

```sh
node --version
npm --version
git --version
docker --version
docker compose version
docker info
supabase --version
```

The bootstrap also uses OpenSSL and ordinary bash utilities, including `awk` and `tr`.
If it names a missing utility, install it in the shell environment the bootstrap uses.
A host PostgreSQL server or host `psql` is not required by the local walkthrough.

**Windows says “No working bash found” or `execvpe(/bin/bash) failed`:** check that
Git Bash is installed. Windows Store and WSL launcher aliases are not the Git Bash
shell. For an unusual installation, set the `PASSCONTROL_BASH` environment variable
to the full path of the working `bash.exe`, then retry. The launcher verifies that
an explicit override can actually execute bash.

**Docker is installed but setup says the daemon is unavailable:** installation alone
is insufficient. Start the engine, wait for it to become ready and retry `docker info`.
A timed-out probe can mean the engine is still starting; if it continues, restart the
engine. On Linux, also check this user's Docker access. Do not reset PassControl data
to repair a Docker connection.

## “The dashboard won't open, or stopped working”

Choose the command for the state you want:

| Command | When to use it |
|---|---|
| `passcontrol setup` | First local setup, or missing stack configuration. Obtains the app checkout if needed, prepares services, migrations and the local account, then starts the dashboard. |
| `passcontrol start` | Bring the local stack back up. Starts services and the dashboard; can obtain the checkout if missing. |
| `passcontrol stop` | Stop the managed dashboard and local services while retaining local data. |
| `passcontrol restart` | Restart the CLI-managed dashboard process. This is not a reset or a complete service restart. |
| `passcontrol status` | Check which gateway is active, which checkout is selected and whether the local dashboard is running. |
| `passcontrol doctor` | Diagnose reachability, configuration and accessible migration state. |
| `passcontrol doctor --deep` | Add prerequisite, authenticated health and Passport/demo diagnostics. |
| `passcontrol doctor --fix` | Attempt to start a stopped local dashboard from an existing configured checkout. Does not repair remote gateways or replace missing setup. |
| `passcontrol local-logs` | Read the managed dashboard's startup/runtime output. If no log exists, start the dashboard first. |
| `passcontrol unlink` | Forget the saved checkout location, for example after moving it. Does not delete the checkout or revoke credentials. Stop the stack first so its location remains available to the stop command. |

`start --dashboard-only` and `stop --dashboard-only` limit those operations to the
application process when you deliberately manage the other services separately.
`local-logs --follow` is available on macOS/Linux; on Windows the CLI refuses live
following and prints the log path. Use `passcontrol local-logs` or open that file.

If `restart` says the dashboard was not started by PassControl, stop the manually
launched process from its own terminal or process manager before retrying. The CLI
refuses to take over an unrelated process merely because it occupies the port.

**A service port is occupied:** use the reported port to identify the other local
stack. Stop that stack if appropriate, or choose a Supabase/Redis offset during setup:

```sh
passcontrol setup --port-offset 100
```

The offset does not move the dashboard: setup uses `http://localhost:3000`.
A CLI gateway value must be a bare origin, with an explicit port for loopback; do not
put a provider path into `PASSCONTROL_GATEWAY`. Provider paths belong in the agent
client's base URL instead.

## “Setup refuses to switch away from my other gateway”

This protects credentials bound to a different gateway. Switching a credentialed remote
profile to local requires a separate interactive confirmation. Noninteractive setup
requires `--forget-active-credentials`; `--yes` is not a substitute. Forgetting local
credentials does not revoke their remote identity. Retire that identity at its original
gateway if that is your intention.

An environment or nearest `.passcontrol` override can take precedence over the global
profile. Setup names and refuses conflicting overrides because writing the global file
would not safely change the active configuration. Resolve the named override first;
see [configuration locations](#i-changed-config-but-the-cli-still-uses-the-old-values).

## “My API key gets `401 invalid_visa`”

If you pasted a **Passport private key** into an API-key field, the refusal is correct.
A Passport is an Ed25519 signing key, not a bearer visa. The gateway attempts visa
verification and rejects it. Other invalid or expired visas can produce the same code;
the code alone does not establish which credential you pasted.

For Passport identity, import the browser-issued Passport using the dashboard's
secret-free import command, then use the Sidecar, MCP or SDK signing path. The secret
belongs at the hidden import prompt, never in the client's provider API-key field.
For a static-key connection directly to the gateway, use a **Direct Agent Key** from
**Connect an agent**. It is a lower-assurance bearer credential bound to one agent;
its calls are not passport-signed. A rejected Direct Agent Key uses `invalid_credential`.

## “Passport or Sidecar authentication says `stale_timestamp`”

The challenge endpoint compares the signed timestamp with the gateway's clock and
returns `401 stale_timestamp` when they differ by more than 90 seconds. The CLI and
sidecar generate this timestamp from the machine's current clock.

Correct the system time and enable time synchronization on the signing machine. Because
you self-host, check the gateway machine's clock too. Restart the signing process and
retry after correcting the clock. Reissuing a key does not correct time skew. A delayed
or replayed challenge can also be stale; if clocks agree, use a newly generated request.

## “The client reaches the sidecar but the model call fails”

Check the **complete base URL**, not just the port. For an Anthropic client it is:

```text
http://127.0.0.1:8788/api/v1/anthropic
```

A bare `http://127.0.0.1:8788` is not the provider base URL. The sidecar forwards normal
request paths without inventing the missing provider prefix. A client appending its
Messages path to the bare origin therefore misses the gateway's provider route.
The resulting message depends on how the client handles the response; inspect its HTTP
status/body and the configured URL before changing credentials.

Use the dashboard's generated configuration or `passcontrol env` with your selected
preset for the correct client-specific path. Some SDK shapes need an additional `v1`
segment; do not apply one provider's URL shape to every client. See the
[endpoint reference](../DOCUMENTATION.md#data-plane--proxy-a-model-call).

## “Calls return `403 blocked_suspended` after I stopped an agent”

This is the intended refusal when an authenticated request hits a readable suspension
or kill state. **Both kill and suspend return `403 blocked_suspended` on the wire.**
Call logs distinguish a kill refusal as `blocked_killed` and suspension as
`blocked_suspended`; the client response deliberately does not reveal which stop fired.

Inspect the agent and kill controls in the dashboard. Resume a suspended agent or disarm
the relevant kill switch only when you intend to allow calls again. Tenant kill controls
also exist as `passcontrol kill on` and `passcontrol kill off`; they require a workspace
control key, not a Direct Agent Key. A platform kill requires the instance operator.
A Passport already inactive when minting may instead be refused at the challenge step.

Stop controls do not cancel a request already dispatched upstream. Redis read failures
have a separate configurable fail mode; see [production guidance](../TUTORIAL.md#9-going-to-production).

## “Calls return `503 blocked_budget_state`”

The gateway cannot safely use the established budget state. This is not the ordinary
“budget exhausted” refusal, and a new allowance or a reset is not a recovery procedure.
Follow [Budget recovery](./budget-recovery.md) for diagnosis and operator recovery.

## “I switched between Passport Sidecar and Direct Agent Key, but calls still fail”

Change **both** the client's base URL and credential:

| Connection | Client base URL | Client credential |
|---|---|---|
| Passport through Sidecar | Loopback with the provider path, such as the Anthropic URL above | The generated dummy API-key value. The sidecar uses its separately configured Passport to mint visas and attach request proofs. |
| Direct Agent Key | Your gateway origin with the provider-specific path from **Connect an agent**, rather than the sidecar listener | The reveal-once Direct Agent Key for that agent. |

Keep the selected model within the destination agent's scope and ensure the destination
workspace has the provider credential. Do not send a dummy key directly to the gateway,
and do not put the Passport private key in either client API-key field.

`passcontrol configure <integration> --write` does **not** universally rewrite a client's
base URL and key or switch it to Direct Agent Key mode. The placeholder means a preset
from `passcontrol --help`; preview without `--write` before making changes:

- The Sidecar file-writing preset creates a new `.aider.conf.yml` in the current
  directory with model, sidecar base URL and a dummy key. It refuses to overwrite an
  existing file, even with `--force`.
- MCP file-writing presets merge only `mcpServers.passcontrol`, keeping other settings.
  A conflicting entry needs `--force`; an existing file is backed up as `.bak`. The entry
  starts the installed CLI's MCP server using global Passport configuration; it does
  not contain a provider key or change unrelated direct-provider settings.
- UI/project-specific presets provide a preview and refuse `--write`. A client-managed
  MCP registry is configured with the client command printed by the preview instead.

The CLI writes files; it does not reload an already-running third-party client. If the
client caches configuration and still uses the old values, fully exit and restart it.
Restart a running sidecar too after changing its Passport or gateway configuration.

## “I changed config but the CLI still uses the old values”

Configuration precedence is **environment → nearest `.passcontrol` → global profile**.
The nearest project file is found by walking upward from the current directory. Inspect
`passcontrol status` from the same directory and shell as the failing command.

| Location | Purpose |
|---|---|
| `.passcontrol` in the current directory or nearest ancestor | Project agent configuration. Overrides matching global values. |
| `~/.config/passcontrol/config` | Default global profile. If `XDG_CONFIG_HOME` is set, its `passcontrol/config` is used instead. `~` means the home directory, including on Windows. |
| `~/.config/passcontrol/app.json` | Default remembered application checkout, beside the global profile. Survives npm uninstall. `passcontrol unlink` forgets it. |
| `.env.docker` in the app checkout | Generated local server/service configuration, not the agent profile. `npm run dev:docker` loads it when launching from source. |

Checkout selection is separate from credential configuration: explicit `--app-dir` on
setup, then `PASSCONTROL_APP_ROOT`, a surrounding app checkout, then the saved checkout.
A new clone defaults to `~/passcontrol`. An explicit override or surrounding checkout
still applies after unlinking a saved path.

Passport secrets may be stored in the OS credential store with a marker in the profile.
Use `passcontrol key status` to inspect custody. Do not paste profile contents, `.env.docker`,
provider keys or Passport secrets into a support report; share the symptom and redacted diagnostics.

## “I want to erase the local installation's data and start again”

Only use this for disposable local data you intend to destroy:

```sh
passcontrol reset --local --confirm RESET
```

It stops the dashboard, discards the local Supabase data without backup, removes the
local Redis volumes and `.env.docker`, then recreates the development stack. It needs
an existing checkout. Run `passcontrol start` afterward to launch the dashboard. Use
`stop` for a pause or `unlink` for a moved checkout; neither means “erase my data.”

## “Setup succeeded — is this production?”

**No.** The generated development configuration and seeded local account are not a
production deployment. Continue with [Tutorial §9: Going to production](../TUTORIAL.md#9-going-to-production)
for Auth/SMTP, secrets, persistence, trusted proxying and reconciliation. For the Workers
target, use [the Cloudflare deployment guide](./deployment/cloudflare.md). A successful
local boot does not verify production operations or provide an independent security audit.
