-- Migration 0004: split the arc-verifier out of proposals.source='reflection'
--
-- WHY
-- Two producers wrote proposals with source='reflection': the reflector
-- (`mars reflect` / `mars arc reflect`) and the arc-outcome verifier
-- (orchestrator/src/core/lib/arc-verifier.ts). Because they shared one value,
-- `source` could not answer the only question it exists to answer — which
-- subsystem produced this row. During a production investigation the newest
-- source='reflection' rows read as healthy deep-reflect output when in fact
-- deep-reflect had written nothing since 2026-07-20 and every recent row was
-- the arc-verifier's.
--
-- The writer now uses source='arc-verifier'. This migration relabels the rows
-- already on disk so historical data is not left ambiguous.
--
-- NOTE: `proposals.source` is a plain `text` column with DEFAULT 'human' (see
-- core/lib/pg-schema.ts) — there is no enum type and no CHECK constraint to
-- alter, so this migration is pure DML. The allowed-value list is enforced in
-- application code by `VALID_SOURCES` / `isProposalSource` in
-- orchestrator/src/core/proposals.ts.
--
-- HOW TO APPLY (operator, manually — nothing runs this automatically):
--   psql "$(cat .mars/pg.dsn)" -f orchestrator/docs/migrations/0004-proposal-source-arc-verifier.sql
--
-- The arc-verifier is the only producer that ever stamped
-- author_kind='agent' AND author_name='arc-verifier', so that pair identifies
-- its rows exactly. The statement is idempotent: re-running it matches nothing
-- because the rows no longer carry source='reflection'.

BEGIN;

UPDATE proposals
   SET source     = 'arc-verifier',
       updated_at = updated_at          -- provenance fix only; not a content edit
 WHERE source      = 'reflection'
   AND author_kind = 'agent'
   AND author_name = 'arc-verifier';

-- Verification (expect 0 rows):
--   SELECT id, source, author_name FROM proposals
--    WHERE source = 'reflection' AND author_name = 'arc-verifier';
--
-- And the relabelled set:
--   SELECT count(*) FROM proposals WHERE source = 'arc-verifier';

COMMIT;
