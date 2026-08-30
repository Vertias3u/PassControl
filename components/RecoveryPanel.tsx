import { Download, BookOpen } from "lucide-react";

function recoveryNoticeHref(): string {
  return "/notices/recovery";
}

// A server component on purpose. Three rows of prose and one download link —
// there is no state, no transition and nothing to hydrate, so shipping this to
// the browser would buy nothing. It also lets the "last export" label render
// from a server-computed timestamp rather than Date.now() in the client, which
// would differ between the server pass and the first paint.
//
// Every class here already exists in globals.css (the .pc-account-lifecycle
// block). Reusing them is not only less CSS: a brand-new class in a file that
// has never been `git add`ed does not compile under this project's Tailwind
// scanner, and the symptom is correct markup with no colour.

function sinceLabel(value: string | null): string {
  if (!value) return "never";
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed)) return "unknown";
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function RecoveryPanel({ lastExportAt }: { lastExportAt: string | null }) {
  return (
    <div className="pc-account-lifecycle" data-testid="recovery-panel">
      <div className="pc-account-lifecycle__row">
        <div>
          <strong>Configuration export</strong>
          <p>
            A JSON copy of your agents, their scopes, budgets, policies and failover order, plus your
            ownership declaration. No secret values: no provider keys, no key hashes, no MFA, no
            private signing material. Restore it into a fresh instance with <code>passcontrol import</code>.
          </p>
          <p data-state={lastExportAt ? "ready" : "attention"}>
            {lastExportAt ? (
              <>Last export: <time dateTime={lastExportAt}>{sinceLabel(lastExportAt)}</time></>
            ) : (
              "No configuration export has been taken from this workspace."
            )}
          </p>
        </div>
        <a className="pc-account-lifecycle__export" href="/api/workspace/export">
          <Download aria-hidden="true" /> Export workspace
        </a>
      </div>

      <div className="pc-account-lifecycle__row">
        <div>
          {/* No icon inside <strong>: preflight sets svg { display: block }, so an
              icon here orphans onto its own line above the heading. The sibling
              AccountLifecycle rows carry plain headings for the same reason. */}
          <strong>Database backup</strong>
          {/* No tick, no green state, and no claim about which hosting plan is
              in play. This page cannot see that, and a status indicator here
              would be an assertion the product cannot back — on the one screen
              an operator reads specifically to find out whether they are
              covered. The absence of a verdict IS the verdict. */}
          <p>
            PassControl cannot see whether a restorable backup of this deployment exists. That depends
            on the hosting plan behind it, which is configured outside this product — this panel would
            read exactly the same whether backups run nightly or have never run at all. If you run this
            deployment, check your provider&apos;s backup settings yourself. If someone else runs it, ask them.
          </p>
        </div>
        {/* In the right-hand slot rather than in the prose: .pc-account-lifecycle__row a
            is styled as a button, so an inline link would render as one mid-paragraph. */}
        <a href={recoveryNoticeHref()}>
          <BookOpen aria-hidden="true" /> What survives a restore
        </a>
      </div>

      <div className="pc-account-lifecycle__row is-danger">
        <div>
          <strong>Provider credentials</strong>
          <p>
            Your provider API keys are encrypted with a key the hosting project holds and never places
            in a database dump. They are in no export and no backup — deliberately, because the
            alternative is a file containing every operator&apos;s plaintext provider keys, which is the
            thing this product exists to prevent. After total project loss they are re-entered by hand,
            one per provider. This is a stated limit, not an oversight.
          </p>
        </div>
      </div>
    </div>
  );
}
