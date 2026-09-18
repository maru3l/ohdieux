# Portable-core interface prototype

> **PROTOTYPE — throwaway planning evidence, not migration implementation.**

This prototype explores the question in [Specify the portable-core interface contract](https://github.com/maru3l/ohdieux/issues/19): does one concrete TypeScript contract make the chosen portable `Ohdieux` module implementable without reopening its architecture?

The prototype is intentionally isolated on the `prototype/portable-core-interface` branch. Nothing here belongs on the migration implementation branch unchanged.

## Run

Open `demo.html` directly in a browser. It has no build step, server, framework, or persistence.

## Files

- `contract.ts` — the proposed TypeScript interface artifact.
- `demo.html` — an in-memory logic demo for the contract's awkward cases: duplicate and conflicting commits, durable retry bookkeeping, HTTP admission failure, sticky programme failure, and an R2/D1 publication gap.

## Designs compared

1. **Minimal interface** — seven public operations, generic administration dispatch, and the smallest possible seam. Deep, but the generic command union gives route callers less leverage.
2. **Caller-first interface** — purpose-built administration methods and route-shaped outcomes. Larger, but ordinary Hono, Cron, and Queue callers become exhaustive and hard to misuse.
3. **Extensible interface** — a type-map job catalog and generic commit algebra. Its compile-time exhaustiveness is valuable; its proposed runtime activation methods on the unauthenticated administration facet are not.
4. **Ports-and-adapters interface** — opaque read tokens, branded durable outbox messages, semantic archive/upstream ports, and distinct effect versus coordination change sets. This most faithfully preserves the Cloudflare/in-memory seam.

The proposed hybrid uses the caller-first inbound interface, closed job catalog, and ports-and-adapters persistence/effect seams. Request identities remain caller-supplied so tests can be deterministic without adding an identity-generator port. WHATWG `ReadableStream<Uint8Array>` is the portable byte-stream type supported by Workers and modern Node. The core returns final RSS XML and dashboard HTML to keep compatibility rendering local.

## Review focus

The demo should make three judgments concrete:

- Is the purpose-built inbound interface preferable to a generic administration dispatcher?
- Does the `effect | coordination` change-set split express every atomic operation without leaking SQL?
- May an R2 put that was durably authorized before `halted` finish after the lifecycle transition? D1 and R2 cannot provide cross-product revocation; the recommendation is to forbid new effects after `halted`, record that an already-started stream may settle, and treat its unrecorded outcome as containment evidence requiring reconciliation.

The issue resolution, not this branch, will hold the accepted decision.
