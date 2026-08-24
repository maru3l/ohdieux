# Legacy compatibility exceptions

This decision resolves [issue #15](https://github.com/maru3l/ohdieux/issues/15) against the [observable compatibility contract](https://github.com/maru3l/ohdieux/blob/25a3f7429146eb54cbd7f2418464fdfdbff305bf/docs/migration/observable-compatibility-contract.md).

The TypeScript migration preserves strict client-visible and persisted-data semantics. Confirmed behavior in the compatibility contract remains required unless this document or the separately resolved audio-archival decision grants an explicit exception. Implementation work must not introduce additional compatibility exceptions ad hoc.

## Required parity

### HTTP

Preserve:

- the route table and query-only parameter binding;
- accepted boolean spellings, defaults, whitespace handling, and first-value handling for duplicate parameters;
- status codes, stable bodies, content types, `HEAD` behavior, and the legacy `404` behavior for unsupported methods and `OPTIONS`;
- stable security and cache headers, the unauthenticated admin surface, and the absence of CORS handling;
- media filename parsing, content disposition, hard-coded audio content type, and the complete audio range matrix, including collapsed multi-range responses; and
- static asset bytes plus cache, range, and conditional-request semantics. Deployment-generated validator values and transport headers were already excluded from byte-stable parity by the compatibility contract.

### RSS

Preserve all selection, ordering, expansion, text-cleaning, date, option, and local-media rules, including:

- `reverse` changing segment order but not episode order;
- episode duration being used as enclosure length;
- hard-coded `audio/mpeg` enclosure types;
- exact stable channel/item content and element order;
- `favor_aac` matching and replacement behavior; and
- configured image and media base URLs being concatenated and applied with legacy semantics.

RSS parity is namespace-aware semantic XML parity, not byte-identical serialization. Parsed content, element order, attributes, namespaces, HTTP content type, and cache metadata must match. Serialization whitespace and equivalent XML declaration formatting may differ.

### Scraping and background jobs

Preserve:

- Radio-Canada endpoint construction, stable request metadata, type-probing order, playback fallback, media-selection order, and persisted-query data;
- stable identifiers, defaults, programme assembly, incremental stopping, pagination direction, maximum-depth behavior, and full-refresh stale-row retention;
- immediate admin acknowledgements and the first unknown-feed `404` before durable work completes;
- sticky `Failed` status, explicit manual reset, exact controlled failure data, and suppression of failed programmes;
- disabled and hourly scheduling behavior, including one incremental refresh request per eligible stored programme; and
- deterministic persisted results independently of queue delivery count.

### Statistics

Preserve dashboard inclusion, ordering, and counting rules. `archived_episodes` continues to count archived media segments rather than distinct episodes. Missing statistics continue to read as zero, and an orphan archive-stat row retains the legacy parsing and error outcome. Recompute remains asynchronous and counts existing archive objects by media segment.

### Non-FFmpeg archival

Preserve:

- image archival while audio archival is disabled;
- revision-zero image nonreplacement;
- unconditional configured local-image URL rewriting;
- image bytes and configured `User-Agent` behavior;
- reads and range serving for existing or migrated audio objects;
- rescan acknowledgement/no-op behavior while audio archival is disabled; and
- segment-based archive-stat recomputation for existing archive objects.

## Explicit strict-compatibility exceptions

1. **XML byte serialization** — RSS output may differ in insignificant serialization whitespace and equivalent XML declaration formatting. Semantic XML and stable HTTP metadata remain strict.
2. **Scheduling configuration** — Cloudflare production accepts `SCRAPER_REFRESH_INTERVAL=0` (disabled) or `3600` (hourly). Any other value fails configuration validation. Arbitrary-second intervals and exact process-local actor/tick timing are unsupported.
3. **Silent scrape failures** — first-page fetch or parse failures and later pagination failures produce an explicit `Failed` outcome. Data durably saved by earlier successful pages remains; failures are not silently ignored or treated as successful truncation.
4. **Scraper crashes and redundant I/O** — all-replay pages use normal traversal order instead of crashing. Any empty page saves programme metadata, retains data from earlier successful pages, and ends traversal successfully without episode work for that page. Unknown upstream types and decode failures become controlled failures. Traversal does not make the legacy redundant page request after the final item.
5. **Actor timing and races** — background work uses durable, at-least-once, idempotent queue delivery. Exact actor concurrency, delivery timing, and archive-before-media-save races are not preserved. Durable state is saved before dependent work is enqueued.
6. **Image archival mechanism** — Cloudflare streams image fetches into R2 instead of invoking `wget` through temporary files. The exact command arguments, temporary filenames, and partial temporary-file residue are not preserved. User agent, stored bytes, no-replacement behavior, and observable success or failure remain required.
7. **Blacklist URL refresh** — URL-refresh behavior that occurs only when audio archival is enabled is covered by the separate unsupported-audio-archive exception and is not independently preserved on Cloudflare.

## Separately decided or out of scope

[Issue #14](https://github.com/maru3l/ohdieux/issues/14) establishes the Cloudflare audio-archive exception: production does not create new audio archives, rejects enabled audio archival, continues image archival, and serves existing or migrated audio objects.

Persistence adapter selection, schema-transfer mechanics, versioned data migration, and rollback are decided by their dedicated tickets. This decision does not relax compatibility for runtime persistence semantics or migrated data.

## Acceptance consequences

Golden-master acceptance must:

- treat every compatibility-contract behavior not excepted above as required parity;
- compare RSS as parsed, namespace-aware XML while separately checking stable element order and HTTP metadata;
- assert explicit failed states for first-page and later-page failures;
- assert non-crashing all-replay and empty-page outcomes and absence of the redundant terminal request;
- test only disabled and hourly Cloudflare schedules and reject other interval values;
- verify duplicate queue delivery is idempotent and dependent work follows durable state; and
- compare image archive results rather than local subprocess and temporary-file details.
