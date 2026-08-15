# Three-workspace invite beta launch

This is an operator runbook, not permission to deploy, migrate, email, push, or publish.
Those outbound actions belong to the owner. The adoption gate is three separate external
workspaces completing a real governed call—not three conversations and not three locally
created accounts.

## What migration 0025 adds

`db/migrations/0025_beta_launch_system.sql` adds minimum-data beta applications, hashed
one-time invitations, optional setup feedback, operator event receipts, and a daily
retention RPC. It changes no existing product table or row, and it revokes permissive
default function execution from public/anon/authenticated roles so later migrations must
grant each callable function deliberately. It does not alter the gateway, budgets, call
logging, provider custody, or current signup path. Missing or invalid
`PASSCONTROL_INVITE_SOURCE` remains `shared`.

Raw invitation tokens are never stored. The emailed URL carries the token in the browser
fragment, so it is not sent in the initial HTTP request or ordinary access logs. Signup
submits it once; the server hashes and atomically claims it before creating the Auth user.
A failed signup strands that token by design. Reissue from the operator page instead of
making a consumed credential reusable. The signup page is not the admission boundary:
migration 0025's Before User Created Auth hook rejects direct calls to Supabase signup that
do not carry the server-claimed invitation identity.

## Exact rollout order

1. Review the activation commit and this migration together. Re-run typecheck, the full
   suite, production build, npm artifact check, and security diff review.
2. Owner applies migration 0025 to the confirmed production Supabase project. Do not set
   `PASSCONTROL_INVITE_SOURCE=database` yet.
3. Verify RLS and grants: `anon` and `authenticated` cannot read applications, invitations
   or operator events; authenticated users can only read their own feedback; all beta
   writes and invitation RPCs are service-role-only. Then run Supabase's Security and
   Performance Advisors against the migrated project. Review every new warning from 0025
   before acknowledging the advisor gate; the earlier 0023 acknowledgement is not evidence
   for the four tables and SECURITY DEFINER functions added here.
4. Configure `public.hook_authorize_beta_signup` as Supabase Auth's **Before User Created**
   Postgres hook immediately after the grant check. Prove a direct request to Supabase
   `/auth/v1/signup` without PassControl's server-added `passcontrol_beta_invite_id` metadata
   is rejected. Supabase documents an empty JSON object as the successful allow response;
   confirm that contract against the deployed Auth version. The hook temporarily stops the
   legacy shared-code signup path. That fail-closed interval is intentional.
5. Set `PASSCONTROL_BETA_OPERATOR_EMAILS`, then owner deploys the application with
   `PASSCONTROL_SIGNUP_MODE=closed` and `PASSCONTROL_INVITE_SOURCE=shared`. This lands
   `/beta`, `/dashboard/beta`, retention and the database code together while keeping the
   public account form honest during the transition. The operator allowlist must be present
   in this deployment because step 6 exercises that page; a later Vercel env save does not
   change an already-built deployment.
6. Confirm the public application form can create one disposable application, while a
   duplicate produces the same generic response. Confirm the operator page is inaccessible
   to a non-allowlisted user, a user without verified TOTP, and an allowlisted aal1 session.
7. Set `RESEND_API_KEY` and `PASSCONTROL_BETA_FROM_EMAIL`, then redeploy before testing
   delivery. Drive an invitation to a disposable email through the
   private operator page. Confirm the email is text-only and the raw token appears neither
   in the database nor server logs. **Never enable Resend's click or open tracking on the
   sending domain.** Click tracking rewrites the URLs inside a message to route through a
   redirect service, and a redirect cannot carry a URL fragment. The invitation token lives
   in the fragment precisely so it never reaches a server or an access log, so enabling
   tracking would both strand every invitee on an empty signup form and copy the raw token
   into the provider's click database. Leave "Enable tracking metrics" unconfigured.
8. Set `PASSCONTROL_SIGNUP_MODE=invite` and `PASSCONTROL_INVITE_SOURCE=database`, then
   redeploy. The shared code is no longer an accepted signup credential. Run
   `npm run check:cloud-beta` with the existing operational acknowledgements, including
   `--ack-beta-auth-hook`. **`vercel env pull` cannot satisfy this check.** Vercel returns an
   empty value for every variable flagged *Sensitive*, so the pulled file misreports roughly a
   dozen present secrets as missing; a run against it fails for reasons that are entirely
   artefacts. Run the check against values supplied deliberately, and verify the deployed
   configuration by behaviour instead: `/signup` must render the invitation form rather than
   **Signups are closed** (proves `invite`), the previous shared `INVITE_CODE` must be refused
   (proves `database`), and the operator page must open for an allowlisted aal2 session
   (proves `PASSCONTROL_BETA_OPERATOR_EMAILS`). Behavioural proof outranks the shape lint —
   the lint only ever checked that a value had the right form.
9. Create an account from the disposable invitation. Confirm wrong-email, reused, revoked
   and expired links all show the same generic refusal. Query `auth.users` by the created
   user ID and confirm its email exactly equals the application's `email_normalized`; confirm
   the accepted application links to that same Auth user. If production email confirmation
   is enabled, also prove the confirmation link completes normally.
10. Drive the first-call activation path using one real provider request. Confirm the funnel
   advances only from the stored `agent_logs` row and the public receipt verifies.
11. Test account export and permanent deletion. Export must contain beta metadata but no raw
    or hashed invite token; deletion must cascade the linked application, invitation,
    feedback, and operator-event rows.
12. Invite three external workspaces one at a time. The owner sends at most one setup nudge
     before a first attempt and one feedback request after a successful call. No automated
     campaign exists.

If a follow-up displays **Delivery state unresolved**, do not retry it. Compare the Resend
delivery record with the `*.pending` operator event, then settle that exact event to `*.sent`
or `*.send_failed` through a reviewed, owner-run database operation. A pending event blocks
duplicates precisely because provider acceptance and the durable event could not be reconciled.

## Rollback

Application rollback comes first. If database-invite signup is unhealthy, set
`PASSCONTROL_SIGNUP_MODE=closed` and redeploy while leaving the Auth hook enabled. Do not
restore the legacy shared-code flow during an incident: it cannot protect direct Supabase
signup. If the hook must be disabled for maintenance, first turn off Supabase Auth's
**Allow new users to sign up** control and keep the application signup mode closed; re-enable
the hook before turning Auth signup or the application form back on. Never run database-invite
signup with the hook disabled. Do not try to reverse migration 0025 during an incident:
its beta rows are evidence and its future-function privilege defaults are intentional.
Revoke live invitations and preserve the event trail.

Vercel Instant Rollback does not restore the previous cron registration. This release adds
`/api/cron/beta-retention`; after an instant application rollback, either redeploy the prior
commit so Vercel receives its earlier cron configuration or disable the orphaned retention
cron manually. A stale invocation against old code is expected to fail safely, but retention
must not be assumed healthy until the schedule matches the running application again.

If an invitee creates an Auth identity but never completes required email confirmation, do
not reissue into the linked application. Verify the exact Auth user ID and email in Supabase,
delete that unconfirmed disposable identity through the Auth administration surface, confirm
the public profile/application cascade completed, and ask the person to apply again. This is
a manual three-workspace-beta recovery path, not a normal invitation state transition.

## Privacy and support

Applications collect email, intended tool/provider, a coarse call-volume bucket, use-case
text, and contact consent. No IP address is stored; Redis receives only domain-separated
HMAC subjects. Pending applications expire after 180 days, declined/withdrawn applications
after 30 days, invitation metadata after 30 days past its relevant terminal date, and setup
feedback after 180 days. Emails are text-only with no open or click tracking.

For support, ask users to download the existing redacted bundle from Dashboard → Operations
and attach it to `hello@vertias.eu`. Never request provider keys, Direct Agent Keys,
passports, recovery codes, prompts, or model responses.
