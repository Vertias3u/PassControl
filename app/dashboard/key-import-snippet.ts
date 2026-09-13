interface ConfigureSnippetInput {
  gateway: string;
  passportId: string;
  provider: string;
  model: string;
  integration: string;
  allowedIntegrations: readonly string[];
}

/**
 * Characters a value may carry into a generated command line: word characters
 * plus the four punctuation marks the real values actually use — `.` and `-` in
 * model ids and base64url, `:` and `/` in an origin. No whitespace, and none of
 * the metacharacters any shell reinterprets.
 */
const PASTEABLE = /^[\w.:/-]+$/u;

/**
 * Check a value instead of quoting it.
 *
 * These strings are built for a clipboard, and the shell on the other end of
 * the paste is not ours to choose. Both values here used to be wrapped in POSIX
 * single quotes, which is correct in bash and zsh and wrong in `cmd.exe` — cmd
 * does not treat `'` as quoting and passes it through as part of the value. So
 * every Windows operator who clicked "Copy import command" was handed a command
 * that could not work, and the CLI then refused a value that looked perfectly
 * right on the line in front of them. It reached us as a bug report about the
 * CLI's error message; the command came from here.
 *
 * A value that needs no quoting is correct in cmd, PowerShell, bash and zsh at
 * once, which is the only property worth having. So the guard refuses anything
 * that would need a shell to unwrap rather than picking a syntax for one of
 * them — and refusing is safe because nothing that reaches here can fail it:
 * `isProvider` is an enum, `clientModelIsUsable` already bars whitespace and
 * metacharacters, an origin comes back normalized from `URL`, and a passport id
 * is base64url. If one ever does fail, a thrown error is the right outcome — a
 * command built around an unchecked value is the injection this replaces.
 */
function pasteable(label: string, value: string): string {
  if (!PASTEABLE.test(value)) {
    throw new Error(`Refusing to build a command: the ${label} is not safe to paste unquoted.`);
  }
  return value;
}

/**
 * Produce a pasteable handoff without duplicating any integration-specific
 * settings. The final command delegates those settings to the shipped CLI's
 * existing `configure` preset implementation.
 *
 * This deliberately does NOT begin with `passcontrol passport import`. The UI
 * gives that command its own step, because importing a private key is its own
 * security decision and reads as one. Repeating it here made the onboarding
 * flow hand the operator the same command twice, and the second run is refused:
 * `passport import` will not replace a configured passport without --replace.
 * The lines are newline-separated rather than `&&`-joined, so the refusal did
 * not stop the rest — it just put a failure in the middle of a flow that then
 * carried on, which is worse than either outcome on its own.
 */
export function buildConfigureSnippet(input: ConfigureSnippetInput): string {
  if (!input.allowedIntegrations.includes(input.integration)) {
    throw new Error("Unknown integration preset.");
  }
  if (!isProvider(input.provider) || !clientModelIsUsable(input.model)) {
    throw new Error("Sidecar setup requires a supported provider and a concrete model id.");
  }
  return [
    `passcontrol configure ${input.integration} --provider ${input.provider} --model ${pasteable("model", input.model)}`,
    "passcontrol sidecar",
  ].join("\n");
}

/**
 * `--flag=value`, not `--flag value`, and the reason is the passport id.
 *
 * base64url's alphabet includes `-`, so about one issued id in 4096 begins
 * `--`. The CLI's `parseArgv` reads `--id VALUE` by taking the next token only
 * when that token does not itself start with `--`, so an id like that is
 * swallowed as a flag name and the operator gets a usage error naming neither
 * the cause nor the value. Quoting never protected against this — the shell
 * strips the quotes before the CLI sees the token, so the POSIX form had the
 * same hole and only looked safe. `=` closes it on every platform at once.
 *
 * `--provider` and `--model` above stay space-separated: neither can begin with
 * a hyphen, so neither can be mistaken for a flag.
 */
export function buildPassportImportCommand(input: { gateway: string; passportId: string }): string {
  const origin = new URL(input.gateway).origin;
  return [
    "passcontrol passport import --global",
    `--gateway=${pasteable("gateway", origin)}`,
    `--id=${pasteable("passport id", input.passportId)}`,
  ].join(" ");
}
import { clientModelIsUsable } from "@/lib/agent-connect";
import { isProvider } from "@/lib/providers";
