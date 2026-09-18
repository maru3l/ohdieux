# Proof results

## Environments

| Environment | Runtime | Date | Verdict |
| --- | --- | --- | --- |
| Local D1 | Wrangler/Miniflare 4.134.0 | 2026-09-18 | Passed |
| Disposable Cloudflare D1 | Wrangler 4.134.0, Worker binding API | 2026-09-18 | Passed |

The disposable remote Worker and D1 database were deleted after the run.

## Cases

| Case | Local | Remote |
| --- | --- | --- |
| Successful read and zero-row update do not abort later statements | Pass | Pass |
| Apply domain, receipt, outbox, and statistics pointer atomically | Pass | Pass |
| Exact effect replay returns `duplicate` with no state change | Pass | Pass |
| Receipt fingerprint mismatch wins over stale preconditions | Pass | Pass |
| All optimistic conflicts return in declaration order and write nothing | Pass | Pass |
| Failed generated postcondition raises `SQLITE_CONSTRAINT_CHECK` and rolls back | Pass | Pass |
| Concurrent contenders produce one `applied` and one `preconditions-failed` | Pass | Pass |
| Receipt-less coordination replays through a retained technical marker | Pass | Pass |

The deliberate postcondition failure returned:

```text
D1_ERROR: CHECK constraint failed: (state = 'claimed' AND claim_nonce IS NOT NULL) OR
    (state = 'committed' AND claim_nonce IS NULL): SQLITE_CONSTRAINT
    (extended: SQLITE_CONSTRAINT_CHECK)
```

The state snapshot after that error exactly matched the snapshot before the attempted commit: no receipt, domain update, outbox row, or statistics pointer survived.

## Scope of proof

This proves the D1 transaction mechanism and representative generated SQL shape. It does not claim that the prototype's tiny schema is the migration schema or that its hard-coded compiler covers every production mutation. Production acceptance must rerun the shared contract suite over every `CommitPrecondition`, `DomainMutation`, and `OperationalMutation` compiler case, plus limit and failure injection.
