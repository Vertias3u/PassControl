-- ============================================================================
-- PassControl — agent_logs learns whether a call could be priced.
--
-- Split out of what was briefly one migration with the spend-statement tables.
-- They are two unrelated changes and they do not belong to the same audience:
-- this column is written by the proxy on every deployment, and the statement
-- chain (0054) is operated by the hosted product. Keeping them in one file
-- meant a self-hosted gateway could not record honest pricing without also
-- carrying an evidence-chain schema it never writes to.
--
-- On a deployment that also operates a spend-statement chain, the chain's window
-- read selects this column, so this file must be applied first. Nothing here
-- depends on that half, which is why they are separable at all.
-- ============================================================================

-- Apply via scripts/migrate.sh, which ledgers each file in
-- public.schema_migrations and will not run this twice.

--
-- `unpriced` exists today only inside a receipt's claims (lib/receipt.ts). The
-- proxy already records cost_microcents = NULL for a call nobody could price, so
-- the cost itself is not the problem — the AMBIGUITY of that NULL is. A BLOCKED
-- call also has no recorded cost, and it is not unpriced: there was nothing to
-- price. Both kinds of row carry a receipt, so both land in a statement's Merkle
-- tree, and a statement that could not tell them apart would report calls it
-- REFUSED as calls it could not price. This column says which.
--
-- NULLABLE WITH NO DEFAULT, AND ONLY THE POSITIVE ASSERTION IS EVER WRITTEN.
-- lib/log.ts writes `true` and otherwise omits the key entirely — the same
-- conditional spread it already uses for `receipt`, `policy_shadow_would` and
-- `sender_proof_would`, and for the same reason: PostgREST rejects the WHOLE
-- insert on an unknown column, so naming this unconditionally would mean a
-- deployment running newer code against a pre-0053 schema writes NO audit rows
-- at all, silently, on every call.
--
-- So a statement reads three states rather than two: `unpriced = true` is known
-- unpriced; NULL with a recorded cost is priced; NULL with no recorded cost is
-- pricing-unknown. Backfilling a default would manufacture the distinction this
-- column exists to record honestly.
alter table public.agent_logs
  add column if not exists unpriced boolean;

comment on column public.agent_logs.unpriced is
  'True when nobody could price this call — it went to a custom endpoint, which '
  'may mark up, re-route, alias onto a local model, or be free. Disambiguates a '
  'NULL cost_microcents, which a BLOCKED call also has and which is not the '
  'same thing: that call was refused, not unpriceable. Only the positive value '
  'is ever written; NULL with a recorded cost is priced, NULL without one is '
  'pricing-unknown. See isPricedEndpoint in lib/pricing.ts.';
