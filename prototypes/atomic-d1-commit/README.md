# Atomic D1 commit protocol prototype

> **Throwaway planning evidence. Do not merge this Worker into the migration.**

This prototype answers the question in [Prove an atomic D1 commit protocol](https://github.com/maru3l/ohdieux/issues/20): can one `D1Database.batch()` deterministically validate receipt identity and optimistic preconditions and then atomically commit domain writes, a receipt, outbox entries, and a statistics-generation pointer?

## Verdict

**Yes, with a claim-and-finalize protocol.** Do not rely on successful reads or zero-row writes to abort a D1 batch. Instead:

1. **Claim** — conditionally insert an in-flight receipt only when its identity is unused and every ordered precondition passes against the transaction's initial state.
2. **Classify** — an in-transaction `SELECT` reports `applied`, `duplicate`, `receipt-fingerprint-mismatch`, or `preconditions-failed`. A `UNION ALL ... ORDER BY ordinal` query returns every failed precondition in declaration order.
3. **Gate** — every mutation is an `INSERT ... SELECT`, `UPDATE`, or `DELETE` gated by the receipt ID plus a private, per-physical-attempt claim nonce. Duplicate and conflict paths therefore execute no domain, outbox, or projection mutation.
4. **Finalize or abort** — the final receipt update verifies generated SQL postconditions for every intended mutation. It sets the receipt to `committed` only when they all hold. Otherwise it deliberately violates the receipt table's state/nonce `CHECK`, making D1 reject the statement and roll back the whole batch.
5. **Replay** — only committed receipts count as duplicates. Return the stored receipt and its durable outbox rows. A different fingerprint for the same receipt identity is an idempotency conflict before ordinary preconditions are considered.

The same shape handles receipt-less coordination by retaining a private `coordination_commits` marker keyed by `commitId`. That marker is an adapter implementation detail, not a domain receipt.

Cloudflare documents that batch statements execute sequentially and non-concurrently as a SQL transaction, that any failed statement aborts or rolls back the sequence, and that results retain statement order: [D1 Database: `batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch). The protocol turns those guarantees into the required commit outcomes without parsing platform error text for expected duplicate/conflict decisions.

## What was proved

Both local Miniflare D1 and a disposable production D1 database passed these scenarios on 2026-09-18 with Wrangler 4.134.0:

- a successful read plus a zero-row update does **not** stop a later outbox insert (negative control);
- one effect atomically applies a domain update, receipt, outbox entry, and statistics pointer;
- exact replay returns `duplicate` without changing state;
- same receipt identity with a different fingerprint returns the idempotency conflict even when ordinary preconditions are now stale;
- multiple failed preconditions return in their original order and write nothing;
- an injected missing mutation fails the final postcondition, raises a `CHECK` constraint, and rolls the entire batch back;
- two concurrent effects expecting the same revision serialize to one `applied` and one optimistic conflict; and
- receipt-less lease coordination applies once and replays as a duplicate through its retained technical marker.

See [RESULTS.md](RESULTS.md) for the captured summary. The disposable Worker and D1 database were deleted after the remote run.

## Production compiler rules

The production D1 adapter should generate, not hand-compose, the SQL sequence. Its compiler must enforce these invariants before I/O:

- each physical call gets a fresh cryptographic claim nonce; retries reuse the semantic identity and fingerprint, never the nonce;
- one claim statement contains the complete precondition conjunction;
- receipt/commit identity classification precedes ordinary precondition classification;
- every mutation includes the exact claim guard;
- each mutation has a generated final-state postcondition;
- contradictory writes to the same logical record are rejected before I/O;
- expected uniqueness behavior is explicit; an unexpected SQL constraint, malformed SQL, quota error, or unavailable D1 remains a persistence failure outside `applied | duplicate | conflict`;
- the final committed receipt/marker and returned outbox rows are read in the same batch;
- batch statement, bound-parameter, row, CPU, and duration limits are validated before I/O; and
- the shared adapter contract suite runs the same cases against in-memory, local D1, and disposable remote D1 adapters.

A mutation statement that unexpectedly affects zero rows must not be trusted merely because D1 calls it successful. Its missing final-state postcondition forces the finalizer to abort.

## Interface adjustments exposed by the proof

The reviewed portable-core prototype needs two small corrections before implementation:

1. An effect already has `receipt.id` and `receipt.fingerprint`; its top-level `commitId` and `fingerprint` are redundant. Use receipt identity for effect idempotency. Keep `commitId` and `fingerprint` only on receipt-less coordination change sets.
2. A duplicate coordination commit has no domain receipt. Change `CommitOutcome.duplicate.receipt` from required to optional (or split effect and coordination outcomes); its durable outbox remains empty.

Recommended representation for optimistic read tokens is an adapter-owned version sidecar keyed by canonical `RecordRef`, with monotonically increasing integer versions updated in the same batch. It avoids changing the permissive legacy compatibility tables solely for concurrency metadata. Lifecycle, jobs, roots, schedule watermark, outbox, and statistics-generation tables may own their versions directly because they are new operational tables.

## Run locally

```bash
cd prototypes/atomic-d1-commit
npm install
npm run check
npm run dev
```

Open <http://127.0.0.1:8787>, then click **Reset the scratch database and run proof**. The proof endpoint destroys and rebuilds only the D1 database bound to this throwaway Worker.

For a disposable remote proof, create a scratch D1 database, copy `wrangler.jsonc` to ignored `wrangler.remote.jsonc`, replace its database name/ID and Worker name, then deploy and run:

```bash
npm run deploy -- --config wrangler.remote.jsonc
node run-proof.mjs https://<scratch-worker>.workers.dev
```

Delete both scratch resources after capturing the result.
