interface Env {
  DB: D1Database;
}

type OutcomeKind =
  | "applied"
  | "duplicate"
  | "receipt-fingerprint-mismatch"
  | "preconditions-failed";

interface EffectInput {
  commitId: string;
  receiptId: string;
  fingerprint: string;
  claimNonce: string;
  expectedLifecycle: string;
  expectedProgrammeRevision: number;
  expectedGenerationState: string;
  nextTitle: string;
  nextPointer: string;
  outboxId: string;
  envelopeJson: string;
  injectMissingProgrammeMutation?: boolean;
}

interface CoordinationInput {
  commitId: string;
  fingerprint: string;
  claimNonce: string;
  expectedLifecycle: string;
  expectedJobState: string;
  leaseToken: string;
}

interface FailedRow {
  ordinal: number;
  kind: string;
  expected: string;
}

interface ProofCase {
  name: string;
  pass: boolean;
  evidence: unknown;
}

type DatabaseScalar = string | number | null;
type DatabaseRow = Record<string, DatabaseScalar>;

function readOutcome(row: DatabaseRow | undefined): OutcomeKind {
  const value = row?.outcome;
  switch (value) {
    case "applied":
    case "duplicate":
    case "receipt-fingerprint-mismatch":
    case "preconditions-failed":
      return value;
    default:
      throw new Error(`Invalid commit outcome: ${String(value)}`);
  }
}

function readFailures(rows: DatabaseRow[]): FailedRow[] {
  return rows.map((row) => {
    if (
      typeof row.ordinal !== "number" ||
      typeof row.kind !== "string" ||
      typeof row.expected !== "string"
    ) {
      throw new Error("Invalid failed-precondition row");
    }
    return {
      ordinal: row.ordinal,
      kind: row.kind,
      expected: row.expected,
    };
  });
}

const SCHEMA = `
DROP TABLE IF EXISTS outbox;
DROP TABLE IF EXISTS effect_receipts;
DROP TABLE IF EXISTS coordination_commits;
DROP TABLE IF EXISTS programmes;
DROP TABLE IF EXISTS statistics_generations;
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS lifecycle;

CREATE TABLE lifecycle (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  state TEXT NOT NULL,
  revision INTEGER NOT NULL
);

CREATE TABLE programmes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  revision INTEGER NOT NULL
);

CREATE TABLE statistics_generations (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  published_pointer TEXT,
  revision INTEGER NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  lease_token TEXT,
  revision INTEGER NOT NULL
);

CREATE TABLE effect_receipts (
  id TEXT PRIMARY KEY,
  commit_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  outcome_digest TEXT NOT NULL,
  state TEXT NOT NULL,
  claim_nonce TEXT,
  CHECK (
    (state = 'claimed' AND claim_nonce IS NOT NULL) OR
    (state = 'committed' AND claim_nonce IS NULL)
  )
);

CREATE TABLE coordination_commits (
  commit_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  state TEXT NOT NULL,
  claim_nonce TEXT,
  CHECK (
    (state = 'claimed' AND claim_nonce IS NOT NULL) OR
    (state = 'committed' AND claim_nonce IS NULL)
  )
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_prompt_at TEXT
);
`;

const FIXTURE = `
DELETE FROM outbox;
DELETE FROM effect_receipts;
DELETE FROM coordination_commits;
DELETE FROM programmes;
DELETE FROM statistics_generations;
DELETE FROM jobs;
DELETE FROM lifecycle;
INSERT INTO lifecycle(singleton, state, revision) VALUES (1, 'active', 1);
INSERT INTO programmes(id, title, revision) VALUES ('programme-1', 'Before', 1);
INSERT INTO statistics_generations(id, state, published_pointer, revision)
VALUES ('generation-1', 'active', NULL, 1);
INSERT INTO jobs(id, state, lease_token, revision)
VALUES ('job-1', 'ready', NULL, 1);
`;

const claimEffectSql = `
INSERT INTO effect_receipts(
  id, commit_id, fingerprint, subject_kind, subject_id,
  completed_at, outcome_digest, state, claim_nonce
)
SELECT ?1, ?2, ?3, 'job', 'job-1', ?4, ?5, 'claimed', ?6
WHERE NOT EXISTS (
  SELECT 1 FROM effect_receipts WHERE id = ?1
)
AND EXISTS (
  SELECT 1 FROM lifecycle
  WHERE singleton = 1 AND state = ?7
)
AND EXISTS (
  SELECT 1 FROM programmes
  WHERE id = 'programme-1' AND revision = ?8
)
AND EXISTS (
  SELECT 1 FROM statistics_generations
  WHERE id = 'generation-1' AND state = ?9
)
`;

const classifyEffectSql = `
SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM effect_receipts
    WHERE id = ?1 AND state = 'claimed' AND claim_nonce = ?2
  ) THEN 'applied'
  WHEN EXISTS (
    SELECT 1 FROM effect_receipts
    WHERE id = ?1 AND state = 'committed' AND fingerprint = ?3
  ) THEN 'duplicate'
  WHEN EXISTS (
    SELECT 1 FROM effect_receipts WHERE id = ?1
  ) THEN 'receipt-fingerprint-mismatch'
  ELSE 'preconditions-failed'
END AS outcome
`;

const failedEffectPreconditionsSql = `
SELECT ordinal, kind, expected FROM (
  SELECT 0 AS ordinal, 'lifecycle-allows' AS kind, ?1 AS expected
  WHERE NOT EXISTS (
    SELECT 1 FROM lifecycle WHERE singleton = 1 AND state = ?1
  )
  UNION ALL
  SELECT 1, 'read-unchanged:programme-1', CAST(?2 AS TEXT)
  WHERE NOT EXISTS (
    SELECT 1 FROM programmes WHERE id = 'programme-1' AND revision = ?2
  )
  UNION ALL
  SELECT 2, 'statistics-generation-active:generation-1', ?3
  WHERE NOT EXISTS (
    SELECT 1 FROM statistics_generations
    WHERE id = 'generation-1' AND state = ?3
  )
)
ORDER BY ordinal
`;

const guardEffect = `EXISTS (
  SELECT 1 FROM effect_receipts
  WHERE id = ? AND state = 'claimed' AND claim_nonce = ?
)`;

const mutateProgrammeSql = `
UPDATE programmes
SET title = ?, revision = revision + 1
WHERE id = 'programme-1' AND ${guardEffect}
`;

const mutateStatisticsSql = `
UPDATE statistics_generations
SET published_pointer = ?, revision = revision + 1
WHERE id = 'generation-1' AND ${guardEffect}
`;

const insertOutboxSql = `
INSERT INTO outbox(id, receipt_id, envelope_json, created_at)
SELECT ?, ?, ?, ?
WHERE ${guardEffect}
`;

const finalizeEffectSql = `
UPDATE effect_receipts
SET
  state = CASE WHEN
    EXISTS (
      SELECT 1 FROM programmes
      WHERE id = 'programme-1' AND title = ?1 AND revision = ?2
    )
    AND EXISTS (
      SELECT 1 FROM statistics_generations
      WHERE id = 'generation-1' AND published_pointer = ?3 AND revision = 2
    )
    AND EXISTS (
      SELECT 1 FROM outbox
      WHERE id = ?4 AND receipt_id = ?5 AND envelope_json = ?6
    )
    THEN 'committed'
    ELSE 'invalid-postcondition'
  END,
  claim_nonce = NULL
WHERE id = ?5 AND state = 'claimed' AND claim_nonce = ?7
`;

const selectReceiptSql = `
SELECT id, commit_id, fingerprint, subject_kind, subject_id,
       completed_at, outcome_digest
FROM effect_receipts
WHERE id = ? AND state = 'committed'
`;

const selectOutboxSql = `
SELECT id, receipt_id, envelope_json, created_at, last_prompt_at
FROM outbox
WHERE receipt_id = ?
ORDER BY id
`;

async function commitEffect(db: D1Database, input: EffectInput) {
  const now = "2026-09-18T00:00:00.000Z";
  const outcomeDigest = `outcome:${input.fingerprint}`;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(claimEffectSql)
      .bind(
        input.receiptId,
        input.commitId,
        input.fingerprint,
        now,
        outcomeDigest,
        input.claimNonce,
        input.expectedLifecycle,
        input.expectedProgrammeRevision,
        input.expectedGenerationState,
      ),
    db
      .prepare(classifyEffectSql)
      .bind(input.receiptId, input.claimNonce, input.fingerprint),
    db
      .prepare(failedEffectPreconditionsSql)
      .bind(
        input.expectedLifecycle,
        input.expectedProgrammeRevision,
        input.expectedGenerationState,
      ),
  ];

  if (!input.injectMissingProgrammeMutation) {
    statements.push(
      db
        .prepare(mutateProgrammeSql)
        .bind(input.nextTitle, input.receiptId, input.claimNonce),
    );
  }

  statements.push(
    db
      .prepare(mutateStatisticsSql)
      .bind(input.nextPointer, input.receiptId, input.claimNonce),
    db
      .prepare(insertOutboxSql)
      .bind(
        input.outboxId,
        input.receiptId,
        input.envelopeJson,
        now,
        input.receiptId,
        input.claimNonce,
      ),
    db
      .prepare(finalizeEffectSql)
      .bind(
        input.nextTitle,
        input.expectedProgrammeRevision + 1,
        input.nextPointer,
        input.outboxId,
        input.receiptId,
        input.envelopeJson,
        input.claimNonce,
      ),
    db.prepare(selectReceiptSql).bind(input.receiptId),
    db.prepare(selectOutboxSql).bind(input.receiptId),
  );

  const results = await db.batch<DatabaseRow>(statements);
  const outcome = readOutcome(results[1]?.results[0]);
  const failed = readFailures(results[2]?.results ?? []);
  const receiptResult = results.at(-2);
  const outboxResult = results.at(-1);

  return {
    outcome,
    failed,
    receipt: receiptResult?.results[0] ?? null,
    durableOutbox: outboxResult?.results ?? [],
    statementMeta: results.map((result) => ({
      changes: result.meta.changes,
      rowsRead: result.meta.rows_read,
      rowsWritten: result.meta.rows_written,
    })),
  };
}

const claimCoordinationSql = `
INSERT INTO coordination_commits(
  commit_id, fingerprint, completed_at, state, claim_nonce
)
SELECT ?1, ?2, ?3, 'claimed', ?4
WHERE NOT EXISTS (
  SELECT 1 FROM coordination_commits WHERE commit_id = ?1
)
AND EXISTS (
  SELECT 1 FROM lifecycle WHERE singleton = 1 AND state = ?5
)
AND EXISTS (
  SELECT 1 FROM jobs
  WHERE id = 'job-1' AND state = ?6 AND lease_token IS NULL
)
`;

const classifyCoordinationSql = `
SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM coordination_commits
    WHERE commit_id = ?1 AND state = 'claimed' AND claim_nonce = ?2
  ) THEN 'applied'
  WHEN EXISTS (
    SELECT 1 FROM coordination_commits
    WHERE commit_id = ?1 AND state = 'committed' AND fingerprint = ?3
  ) THEN 'duplicate'
  WHEN EXISTS (
    SELECT 1 FROM coordination_commits WHERE commit_id = ?1
  ) THEN 'receipt-fingerprint-mismatch'
  ELSE 'preconditions-failed'
END AS outcome
`;

const failedCoordinationPreconditionsSql = `
SELECT ordinal, kind, expected FROM (
  SELECT 0 AS ordinal, 'lifecycle-allows' AS kind, ?1 AS expected
  WHERE NOT EXISTS (
    SELECT 1 FROM lifecycle WHERE singleton = 1 AND state = ?1
  )
  UNION ALL
  SELECT 1, 'job-state:job-1', ?2
  WHERE NOT EXISTS (
    SELECT 1 FROM jobs
    WHERE id = 'job-1' AND state = ?2 AND lease_token IS NULL
  )
)
ORDER BY ordinal
`;

const guardCoordination = `EXISTS (
  SELECT 1 FROM coordination_commits
  WHERE commit_id = ? AND state = 'claimed' AND claim_nonce = ?
)`;

const mutateJobSql = `
UPDATE jobs
SET state = 'leased', lease_token = ?, revision = revision + 1
WHERE id = 'job-1' AND ${guardCoordination}
`;

const finalizeCoordinationSql = `
UPDATE coordination_commits
SET
  state = CASE WHEN EXISTS (
    SELECT 1 FROM jobs
    WHERE id = 'job-1' AND state = 'leased' AND lease_token = ?1 AND revision = 2
  ) THEN 'committed' ELSE 'invalid-postcondition' END,
  claim_nonce = NULL
WHERE commit_id = ?2 AND state = 'claimed' AND claim_nonce = ?3
`;

async function commitCoordination(db: D1Database, input: CoordinationInput) {
  const results = await db.batch<DatabaseRow>([
    db
      .prepare(claimCoordinationSql)
      .bind(
        input.commitId,
        input.fingerprint,
        "2026-09-18T00:00:00.000Z",
        input.claimNonce,
        input.expectedLifecycle,
        input.expectedJobState,
      ),
    db
      .prepare(classifyCoordinationSql)
      .bind(input.commitId, input.claimNonce, input.fingerprint),
    db
      .prepare(failedCoordinationPreconditionsSql)
      .bind(input.expectedLifecycle, input.expectedJobState),
    db
      .prepare(mutateJobSql)
      .bind(input.leaseToken, input.commitId, input.claimNonce),
    db
      .prepare(finalizeCoordinationSql)
      .bind(input.leaseToken, input.commitId, input.claimNonce),
    db
      .prepare(
        `SELECT commit_id, fingerprint, completed_at
         FROM coordination_commits
         WHERE commit_id = ? AND state = 'committed'`,
      )
      .bind(input.commitId),
  ]);

  return {
    outcome: readOutcome(results[1]?.results[0]),
    failed: readFailures(results[2]?.results ?? []),
    marker: results[5]?.results[0] ?? null,
    statementMeta: results.map((result) => ({
      changes: result.meta.changes,
      rowsRead: result.meta.rows_read,
      rowsWritten: result.meta.rows_written,
    })),
  };
}

async function executeScript(db: D1Database, sql: string) {
  const statements = sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await db.prepare(statement).run();
  }
}

async function resetFixture(db: D1Database) {
  await executeScript(db, FIXTURE);
}

async function snapshot(db: D1Database) {
  const [lifecycle, programmes, generations, jobs, receipts, coordination, outbox] =
    await db.batch<DatabaseRow>([
      db.prepare("SELECT * FROM lifecycle ORDER BY singleton"),
      db.prepare("SELECT * FROM programmes ORDER BY id"),
      db.prepare("SELECT * FROM statistics_generations ORDER BY id"),
      db.prepare("SELECT * FROM jobs ORDER BY id"),
      db.prepare("SELECT * FROM effect_receipts ORDER BY id"),
      db.prepare("SELECT * FROM coordination_commits ORDER BY commit_id"),
      db.prepare("SELECT * FROM outbox ORDER BY id"),
    ]);

  return {
    lifecycle: lifecycle.results,
    programmes: programmes.results,
    generations: generations.results,
    jobs: jobs.results,
    receipts: receipts.results,
    coordination: coordination.results,
    outbox: outbox.results,
  };
}

function effect(overrides: Partial<EffectInput> = {}): EffectInput {
  return {
    commitId: "commit-1",
    receiptId: "receipt-1",
    fingerprint: "fingerprint-1",
    claimNonce: crypto.randomUUID(),
    expectedLifecycle: "active",
    expectedProgrammeRevision: 1,
    expectedGenerationState: "active",
    nextTitle: "After",
    nextPointer: "generation-1:published",
    outboxId: "outbox-1",
    envelopeJson: '{"version":1,"jobId":"job-child-1"}',
    ...overrides,
  };
}

async function runProof(db: D1Database) {
  await executeScript(db, SCHEMA);
  const cases: ProofCase[] = [];

  await resetFixture(db);
  const naïve = await db.batch([
    db.prepare("SELECT state FROM lifecycle WHERE singleton = 1"),
    db.prepare(
      "UPDATE programmes SET title = 'Must not happen' WHERE id = 'programme-1' AND revision = 999",
    ),
    db
      .prepare(
        "INSERT INTO outbox(id, receipt_id, envelope_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(
        "naive-outbox",
        "no-receipt",
        "{}",
        "2026-09-18T00:00:00.000Z",
      ),
  ]);
  const naïveState = await snapshot(db);
  cases.push({
    name: "control: successful read and zero-row update do not abort a batch",
    pass:
      naïve[1]?.meta.changes === 0 &&
      naïveState.outbox.some((row) => row.id === "naive-outbox"),
    evidence: { statementMeta: naïve.map((result) => result.meta), state: naïveState },
  });

  await resetFixture(db);
  const applied = await commitEffect(db, effect());
  const appliedState = await snapshot(db);
  cases.push({
    name: "effect: apply domain, receipt, outbox, and statistics pointer atomically",
    pass:
      applied.outcome === "applied" &&
      appliedState.programmes[0]?.title === "After" &&
      appliedState.generations[0]?.published_pointer ===
        "generation-1:published" &&
      appliedState.receipts.length === 1 &&
      appliedState.outbox.length === 1,
    evidence: { result: applied, state: appliedState },
  });

  const duplicateBefore = JSON.stringify(appliedState);
  const duplicate = await commitEffect(
    db,
    effect({ claimNonce: crypto.randomUUID() }),
  );
  const duplicateState = await snapshot(db);
  cases.push({
    name: "effect: exact replay is duplicate with no state change",
    pass:
      duplicate.outcome === "duplicate" &&
      JSON.stringify(duplicateState) === duplicateBefore,
    evidence: { result: duplicate, state: duplicateState },
  });

  const mismatch = await commitEffect(
    db,
    effect({ fingerprint: "different-fingerprint", claimNonce: crypto.randomUUID() }),
  );
  const mismatchState = await snapshot(db);
  cases.push({
    name: "effect: receipt fingerprint mismatch wins over stale preconditions",
    pass:
      mismatch.outcome === "receipt-fingerprint-mismatch" &&
      JSON.stringify(mismatchState) === duplicateBefore,
    evidence: { result: mismatch, state: mismatchState },
  });

  await resetFixture(db);
  await db.batch([
    db.prepare("UPDATE lifecycle SET state = 'halted', revision = revision + 1"),
    db.prepare(
      "UPDATE statistics_generations SET state = 'failed', revision = revision + 1",
    ),
  ]);
  const conflictBefore = JSON.stringify(await snapshot(db));
  const conflict = await commitEffect(
    db,
    effect({ expectedProgrammeRevision: 99 }),
  );
  const conflictState = await snapshot(db);
  cases.push({
    name: "effect: all failed preconditions are returned in declaration order",
    pass:
      conflict.outcome === "preconditions-failed" &&
      conflict.failed.map((failure) => failure.ordinal).join(",") === "0,1,2" &&
      JSON.stringify(conflictState) === conflictBefore,
    evidence: { result: conflict, state: conflictState },
  });

  await resetFixture(db);
  const beforeAbort = JSON.stringify(await snapshot(db));
  let abortError = "";
  try {
    await commitEffect(db, effect({ injectMissingProgrammeMutation: true }));
  } catch (error) {
    abortError = error instanceof Error ? error.message : String(error);
  }
  const afterAbort = await snapshot(db);
  cases.push({
    name: "effect: failed final postcondition raises a constraint and rolls back",
    pass:
      abortError.includes("CHECK constraint failed") &&
      JSON.stringify(afterAbort) === beforeAbort,
    evidence: { error: abortError, state: afterAbort },
  });

  await resetFixture(db);
  const contenders = await Promise.all([
    commitEffect(
      db,
      effect({
        commitId: "race-a",
        receiptId: "race-receipt-a",
        fingerprint: "race-fingerprint-a",
        outboxId: "race-outbox-a",
        nextTitle: "Race A",
        nextPointer: "race:a",
      }),
    ),
    commitEffect(
      db,
      effect({
        commitId: "race-b",
        receiptId: "race-receipt-b",
        fingerprint: "race-fingerprint-b",
        outboxId: "race-outbox-b",
        nextTitle: "Race B",
        nextPointer: "race:b",
      }),
    ),
  ]);
  const raceState = await snapshot(db);
  const raceOutcomes = contenders
    .map((candidate) => candidate.outcome)
    .sort((left, right) => left.localeCompare(right));
  cases.push({
    name: "effect: concurrent optimistic contenders serialize to one apply and one conflict",
    pass:
      raceOutcomes.join(",") === "applied,preconditions-failed" &&
      raceState.receipts.length === 1 &&
      raceState.outbox.length === 1 &&
      raceState.programmes[0]?.revision === 2,
    evidence: { contenders, state: raceState },
  });

  await resetFixture(db);
  const coordinationInput: CoordinationInput = {
    commitId: "coordination-1",
    fingerprint: "coordination-fingerprint-1",
    claimNonce: crypto.randomUUID(),
    expectedLifecycle: "active",
    expectedJobState: "ready",
    leaseToken: "lease-1",
  };
  const coordinated = await commitCoordination(db, coordinationInput);
  const coordinatedState = await snapshot(db);
  const coordinatedReplay = await commitCoordination(db, {
    ...coordinationInput,
    claimNonce: crypto.randomUUID(),
  });
  const coordinatedReplayState = await snapshot(db);
  cases.push({
    name: "coordination: retained technical marker makes lease acquisition duplicate-safe",
    pass:
      coordinated.outcome === "applied" &&
      coordinatedReplay.outcome === "duplicate" &&
      coordinatedState.jobs[0]?.lease_token === "lease-1" &&
      JSON.stringify(coordinatedReplayState) === JSON.stringify(coordinatedState),
    evidence: {
      first: coordinated,
      replay: coordinatedReplay,
      state: coordinatedReplayState,
    },
  });

  return {
    question:
      "Can D1Database.batch() deterministically return applied, duplicate, or conflict while atomically committing all effect records despite reads and zero-row writes being successful statements?",
    verdict: cases.every((proofCase) => proofCase.pass) ? "proved" : "failed",
    environment: "D1 Worker binding",
    protocol:
      "Claim a constrained in-flight receipt/technical marker only when all preconditions pass; gate every mutation on that claim; classify from an in-transaction SELECT; finalize through a CHECK-constrained postcondition update; retain committed identity for replay.",
    cases,
  };
}

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Atomic D1 commit protocol prototype</title>
  <style>
    :root{font-family:ui-sans-serif,system-ui,sans-serif;color:#162033;background:#f5f7fb}body{max-width:980px;margin:0 auto;padding:3rem 1.25rem}h1{font-size:2rem;margin:.2rem 0}.lede{font-size:1.05rem;line-height:1.6;color:#475569;max-width:75ch}.card{background:white;border:1px solid #dbe2ea;border-radius:14px;padding:1.25rem;margin:1rem 0;box-shadow:0 8px 24px #1e293b0d}button{border:0;border-radius:9px;background:#3157d5;color:white;padding:.8rem 1rem;font-weight:700;cursor:pointer}button:disabled{opacity:.5}.pass{color:#15803d}.fail{color:#b91c1c}pre{overflow:auto;background:#0f172a;color:#dbeafe;padding:1rem;border-radius:10px;font-size:.8rem;line-height:1.45}ol{line-height:1.6}</style>
</head>
<body>
  <p><strong>THROWAWAY PROTOTYPE</strong></p>
  <h1>Atomic D1 commit protocol</h1>
  <p class="lede">This demo asks whether one D1 batch can validate receipt identity and optimistic preconditions, then atomically commit domain changes, a receipt, outbox work, and a statistics-generation pointer. It deliberately proves first that a successful read and a zero-row update do <em>not</em> abort later statements.</p>
  <div class="card">
    <h2>Protocol under review</h2>
    <ol>
      <li>Conditionally insert an in-flight claim only if receipt identity is unused and every precondition matches.</li>
      <li>Classify the same transaction as applied, duplicate, receipt mismatch, or precondition conflict.</li>
      <li>Gate every mutation on the private claim nonce.</li>
      <li>Finalize the claim only when generated SQL postconditions prove every intended row; a CHECK violation aborts the whole batch otherwise.</li>
      <li>Keep committed identity for deterministic replay.</li>
    </ol>
    <button id="run">Reset the scratch database and run proof</button>
  </div>
  <div id="summary" class="card">No run yet.</div>
  <pre id="details">Click the button to inspect full state and statement metadata.</pre>
<script>
const run = document.querySelector('#run');
const summary = document.querySelector('#summary');
const details = document.querySelector('#details');
run.addEventListener('click', async () => {
  run.disabled = true; summary.textContent = 'Running…';
  try {
    const response = await fetch('/proof', {method:'POST'});
    const proof = await response.json();
    summary.innerHTML = '<h2 class="'+(proof.verdict==='proved'?'pass':'fail')+'">'+proof.verdict.toUpperCase()+'</h2>' + proof.cases.map(c => '<p class="'+(c.pass?'pass':'fail')+'">'+(c.pass?'✓':'✗')+' '+c.name+'</p>').join('');
    details.textContent = JSON.stringify(proof, null, 2);
  } catch (error) { summary.textContent = String(error); }
  finally { run.disabled = false; }
});
</script>
</body>
</html>`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("Invalid request URL", { status: 400 });
    }
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/proof" && request.method === "POST") {
      try {
        return Response.json(await runProof(env.DB));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
