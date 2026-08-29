export interface ReleaseNote {
  version: string;
  date: string;
  title: string;
  headline: string;
  highlights: { title: string; body: string }[];
  changed?: string[];
  fixed?: string[];
  security?: string[];
  technical?: { title: string; body: string }[];
}

// Public, hand-written release copy only. This deliberately has no private-log,
// database, or CMS input: every claim should be visible and reviewable in a diff.
export const RELEASE_NOTES: readonly ReleaseNote[] = [
  {
    version: "0.8.0",
    date: "2026-08-28",
    title: "Setup that proves itself",
    headline:
      "Signing in now ends with your agent making a real governed call and handing you a receipt anyone can check — and you can sign out again.",
    highlights: [
      {
        title: "You watch it work",
        body:
          "Setup used to finish by telling you to go and try something. Now it tries it for you: the moment your machine is configured, PassControl makes one real governed call on your agent's behalf and shows you the signed receipt for it. The receipt is a small file that anyone can verify against our public key — no account, no access to your logs, no taking our word for it.",
      },
      {
        title: "You can sign out",
        body:
          "`passcontrol logout` revokes that machine's key and clears its credentials, leaving your provider and model settings alone. It asks before it does, because the passport it clears is a private key we have never held a copy of — once it's gone, it's gone.",
      },
      {
        title: "Keys nobody uses now expire",
        body:
          "Every machine you sign in on gets its own control key. Laptops get replaced and containers get thrown away, and those keys used to live forever. Now they carry a 90-day idle window that resets every time the key is used — so a machine you actually work on never expires, and one sitting in a drawer stops working.",
      },
      {
        title: "This page",
        body:
          "PassControl now has a public record of what changes. The practical version of each release comes first; the technical section is there when you want it.",
      },
      {
        title: "Creating an agent stops handing you secrets to carry",
        body:
          "`passcontrol agent create` used to end with two 43-character strings and an instruction to paste them into a file. It now points at signing in on the machine that will run the agent, which copies nothing at all — and `--write` saves the passport straight to your config instead of putting it on your screen.",
      },
    ],
    changed: [
      "`passcontrol try` has been removed. Signing in now does the same thing with your own agent instead of a shared demo one. Typing `try` tells you that rather than pretending the command never existed.",
      "`passcontrol doctor --deep` runs the whole chain — sign a challenge, make a governed call, fetch its receipt, verify the signature — instead of stopping at \"a visa can be minted\".",
      "The documentation now opens with the hosted path. It used to open with Docker and a local database, which is the harder of the two ways to use PassControl and not the one most people want.",
    ],
    fixed: [
      "Signing in never offered to reuse an agent you already had, so every sign-in quietly created a new one. The list it read was always empty — we were reading the wrong level of the API response. If you signed in twice on 0.7.x you have a duplicate agent per sign-in; they are safe to revoke.",
      "The test suite took two minutes because one test spent ninety seconds of real time waiting out a timeout. It now takes about twenty seconds, and that test got stricter rather than looser.",
    ],
    security: [
      "Control keys can expire (migration 0041). Keys created before this update are unaffected and never expire on their own — retiring them stays a decision you make, not something an update does to you.",
      "An expired key is refused with exactly the same answer as an unknown one. Telling an unauthenticated caller that a key *used* to exist would confirm they had guessed a real one.",
    ],
    technical: [
      {
        title: "How the proof is put together",
        body:
          "The CLI signs a challenge with the passport it just wrote, receives a short-lived HS256 work-visa, and calls the keyless demo provider — which runs the full governance pipeline (kill switch, scope, policy, budget) and synthesizes the model response rather than resolving a Vault key or forwarding upstream. The response carries an `x-passcontrol-receipt-id`; the CLI fetches that call's row, takes the Ed25519 JWS receipt, and verifies it locally against the gateway's `/.well-known/jwks.json`. No part of this is new server surface — every leg already existed and was reachable.",
      },
      {
        title: "Why the idle window rolls instead of capping",
        body:
          "An absolute 90-day cap would retire a key that is in use every day, which breaks working pipelines on a schedule and buys nothing: a key someone uses constantly is a key they would notice losing. The threat is the key nobody is watching. So the deadline moves forward on every successful authentication, and only in the success path — a request that gets refused cannot keep a dead key alive for another window. Keys with no deadline are never given one by being used; the window is a property of how a key was minted, not something authentication decides. The column is not client-writable: migration 0012 grants `authenticated` update on `revoked_at` by column, so nothing in a browser can move the number.",
      },
      {
        title: "Why `agent rotate` still shows you the secret",
        body:
          "The private key is generated on your machine and discarded when the command exits — the server has never held it, and rotation mints a new key rather than re-revealing the old one. A default that neither printed nor stored the secret would create an agent whose passport was already lost. Rotation also refuses to write the file, because doing so mid-grace-window would destroy the only copy of the key that is still working.",
      },
    ],
  },

  {
    version: "0.7.2",
    date: "2026-08-28",
    title: "An error message that pointed at the wrong thing",
    headline:
      "Signing in could fail with instructions to change a setting you had never set. It now names the file the setting actually came from.",
    highlights: [
      {
        title: "The fix",
        body:
          "If signing in could not reach the gateway, it told you to unset an environment variable. For most people that variable was not set — the value came from a configuration file written months earlier. So you would run the command it suggested, nothing would change, and PassControl would look broken when it was merely configured. It now tells you which file the address came from, and what to edit.",
      },
    ],
    technical: [
      {
        title: "Why it was wrong",
        body:
          "The CLI copies values out of `.passcontrol` and the global profile into the process environment at startup, so by the time the error was written, \"the shell said so\" and \"a file on disk said so\" were indistinguishable. The CLI already tracked which keys had been injected from a file — that distinction exists so a checked-in config cannot pass itself off as an operator decision for security-relevant settings. This applies the same distinction to advice. It also takes the *last* matching config source rather than the first, because a project file overrides the global one, and naming a file whose value never took effect is the same failure with the operands swapped.",
      },
    ],
  },

  {
    version: "0.7.1",
    date: "2026-08-28",
    title: "Signing in pointed at your own computer",
    headline:
      "On a fresh install, `passcontrol login` tried to reach a gateway on localhost instead of PassControl Cloud, and failed for everyone who had not already set one up.",
    highlights: [
      {
        title: "The fix",
        body:
          "Signing in now defaults to Cloud. If you self-host, a gateway you have configured still wins — the point of signing in is to reach your gateway, not ours.",
      },
    ],
    technical: [
      {
        title: "What went wrong",
        body:
          "Every other command falls back to `http://localhost:3000`, which is right for them: they run after you have set something up, and a local stack is a reasonable guess. Signing in is the one command designed to run *before* any configuration exists, so it needed its own default and did not get one in the published build. Confirmed by unpacking the published 0.7.0 artifact rather than by reading the source, which was already correct — the package check counts files, it does not read them.",
      },
    ],
  },

  {
    version: "0.7.0",
    date: "2026-08-27",
    title: "Sign in from your browser",
    headline:
      "Setting up a machine took eight steps and two 43-character secrets copied out of a web page. Now it is one command and one click.",
    highlights: [
      {
        title: "One command, one approval",
        body:
          "`passcontrol login` shows you an eight-character code and opens the approval page. You type the code, press Approve, and your machine is configured. Nothing gets copied between a browser and a terminal — which is where this project's one real support incident came from: a passport secret pasted into a field expecting a provider key, rejected with no explanation.",
      },
      {
        title: "The key still never leaves your machine",
        body:
          "The keypair that proves your agent's identity is generated on your computer, and only the public half is ever sent. That has always been true and this did not change it. It is the whole product.",
      },
    ],
    security: [
      "You type the code yourself, on purpose. **We will never send you an approval link with the code already filled in.** If you receive one, it is not from us.",
    ],
    technical: [
      {
        title: "Why the code is typed and not pre-filled",
        body:
          "An earlier design opened the approval page with the code in the URL, which is friendlier and is an account-takeover vector. In a device-authorization flow, the human carrying the code from the terminal to the browser *is* the channel binding — it is the only thing proving that the person approving is the person who asked. Pre-filling removes it: an attacker starts the flow on their own machine, sends you the link, and one click on your already-signed-in browser hands them a write-scoped key to your workspace. The published build is pinned by a test that fails if the approval URL ever grows a fragment or a query string.",
      },
      {
        title: "How the credential is handed over",
        body:
          "The browser never receives the API key and no callback URL is registered anywhere, which removes the open-redirect and code-interception surface a real OAuth loopback flow would add. The CLI polls for its own grant using a secret device code it alone holds; the browser leg only ever carries the short, low-value user code. The grant is sealed at rest and redeemed exactly once, atomically.",
      },
    ],
  },

  {
    version: "0.6.2",
    date: "2026-08-25",
    title: "Gemini, and a 404 that says something",
    headline: "Google's Gemini models work through the gateway, and a wrong URL gets a real page.",
    highlights: [
      {
        title: "Gemini support",
        body:
          "Gemini is available through Google's OpenAI-compatible endpoint, so it works the same way every other provider does: point your agent at the gateway, and the real key is injected from the vault at call time.",
      },
      {
        title: "A better 404",
        body: "A mistyped address gets a page that helps instead of a blank one.",
      },
    ],
  },

  {
    version: "0.6.1",
    date: "2026-08-16",
    title: "Fixes to the connector and the local stack",
    headline:
      "The connector stopped taking egress permissions from a file, and a Docker daemon that is merely starting up is no longer reported as stopped.",
    highlights: [
      {
        title: "Tunnel destinations are yours to name",
        body:
          "The connector can be told which hosts an agent may tunnel to. A `.passcontrol` file — the kind that travels with a cloned repository — was able to add destinations to a connector started with no flags, and say nothing about it. That list now comes from you, on the command line, or not at all.",
      },
      {
        title: "Cold Docker is not broken Docker",
        body:
          "Starting the local stack while Docker Desktop was still warming up reported the daemon as stopped, which sent people to restart something that was already on its way up.",
      },
    ],
  },

  {
    version: "0.6.0",
    date: "2026-08-15",
    title: "The connector, and a second factor on every credential",
    headline:
      "Any tool that takes a base URL and an API key can now use passport identity — and creating or changing a credential in the dashboard requires your second factor.",
    highlights: [
      {
        title: "A front door for tools that only speak API key",
        body:
          "Most agent tools accept a base URL and a key and nothing else. The connector is a small local process that holds your passport, mints and refreshes visas, and answers on a stable address — so those tools get governed identity with a dummy key, and never hold a real one.",
      },
      {
        title: "It refuses to intercept TLS, and says so",
        body:
          "Configured as an HTTPS proxy, the connector refuses tunnels rather than terminating them. Governing a tunnel would mean installing a certificate authority on your machine that can impersonate any site to any program that trusts it. PassControl exists to get one provider secret off your machine; installing a broader one to save an environment variable is the wrong trade. It answers honestly with the address to use instead, rather than quietly tunnelling a call that looks governed and is not.",
      },
      {
        title: "Second factor on credential changes",
        body:
          "Minting an API key, adding a provider key, or rotating a passport now requires a second factor if you have one enrolled. Stopping a leaking credential deliberately does not — making it harder to stop a leak than to create one would be the wrong way round.",
      },
    ],
  },

  {
    version: "0.5.3",
    date: "2026-08-06",
    title: "Earlier releases",
    headline:
      "PassControl has been published since late July. These notes begin at 0.6.0 — earlier versions are in the repository's history.",
    highlights: [
      {
        title: "Why the notes start here",
        body:
          "Writing entries for versions we would have to reconstruct from commit messages would mean guessing at what shipped, and everything on this page is a claim about a security product. Rather than invent a history, we started keeping one. The full commit history is public.",
      },
    ],
  },
];
