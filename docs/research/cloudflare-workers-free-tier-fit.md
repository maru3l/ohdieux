# Cloudflare Workers compatibility and free-tier fit

_Research snapshot: 2026-08-19. Scope: [Assess Workers compatibility and free-tier fit](https://github.com/maru3l/ohdieux/issues/3), supporting [Specify the TypeScript migration to Cloudflare Workers](https://github.com/maru3l/ohdieux/issues/2). This is planning evidence, not an implementation._

## Decision

**The default Ohdieux service can fit Cloudflare's free products, but only conditionally.** HTTP/RSS, the admin endpoints, SQLite-shaped metadata, hourly scraping, archived images, range-capable object serving, and the existing static site all have direct Cloudflare equivalents. The smallest credible production surface is:

- one Worker for HTTP/RSS/admin and background consumers;
- one D1 database;
- one R2 Standard bucket;
- one hourly Cron Trigger;
- one Queue carrying small, idempotent scrape/archive tasks; and
- Workers Static Assets.

**Do not add Workflows to the baseline.** Queues match the required fan-out and one-step retry jobs more directly, while Workflows add another quota and do not remove the free plan's CPU or external-subrequest constraints.

This is not an unconditional “free-tier compatible” verdict:

1. The current FFmpeg media-archival path cannot run faithfully in Workers. A Worker cannot spawn FFmpeg, and byte-copying an upstream progressive response does not reproduce FFmpeg's HLS ingestion/remux behavior.
2. The current archive grows without a bound. R2's free allowance is finite, so faithful, indefinitely growing media archival cannot be guaranteed to remain free.
3. Free Workers allow only 10 ms of active CPU per invocation. RSS/admin rendering and scrape JSON parsing need representative benchmarks; the repository has no production traffic or data set from which to prove the budget.
4. A monolithic hourly sweep cannot be ported as-is. It must be decomposed across Queue messages to stay inside CPU and subrequest limits.

Therefore the implementation specification needs an explicit archive decision: retain the existing **default** (`ARCHIVE_MEDIA=false`) for Cloudflare production, accept changed “progressive files only, copied as-is” archival semantics, or introduce non-Workers compute and paid operation. The third option conflicts with the map's Cloudflare-only/free-tier destination.

## What the current application actually requires

The relevant behavior is spread across the routing, actor, persistence, and archive code:

- [`routes`](../../src/main/resources/routes) exposes health, dynamic RSS, an unauthenticated dynamic admin dashboard and POST actions, archived image/audio endpoints, and static files.
- [`application.conf`](../../src/main/resources/application.conf) defaults to an hourly (`3600` second) refresh, at most 500 episodes per programme, automatic tracking after an unknown RSS request, media archival off, and upstream media/image URLs in RSS unless archive-serving toggles are enabled.
- [`ManifestController.scala`](../../src/main/scala/ca/ligature/ohdieux/controllers/ManifestController.scala) renders XML from stored data, returns `404` when a programme is unknown, and advertises a 30-minute cache lifetime with one-day stale-if-error.
- [`ManifestService.scala`](../../src/main/scala/ca/ligature/ohdieux/services/manifest/ManifestService.scala) asynchronously starts scraping an unknown programme while still returning that first `404`.
- [`ProgrammeScraperActor.scala`](../../src/main/scala/ca/ligature/ohdieux/actors/scraper/programme/ProgrammeScraperActor.scala) wakes on a process-local timer, walks every known programme serially, and skips programmes marked failed.
- [`ProgrammeScraperActorImpl.scala`](../../src/main/scala/ca/ligature/ohdieux/actors/scraper/programme/ProgrammeScraperActorImpl.scala) pages Radio-Canada, upserts programme/episode metadata, and can walk up to the configured 500 episodes. [`MediaScraperActorImpl.scala`](../../src/main/scala/ca/ligature/ohdieux/actors/scraper/media/MediaScraperActorImpl.scala) may make a playback-list request and tries progressive media before HLS.
- The five repository implementations under [`persistence/impl`](../../src/main/scala/ca/ligature/ohdieux/persistence/impl/) create and query ordinary SQLite tables for programmes, episodes, media, programme status, and archive statistics.
- [`FileArchiveActorImpl.scala`](../../src/main/scala/ca/ligature/ohdieux/actors/file/impl/FileArchiveActorImpl.scala) runs `wget` for images and `ffmpeg -acodec copy` for media, then [`ArchivedFileRepository.scala`](../../src/main/scala/ca/ligature/ohdieux/actors/file/impl/ArchivedFileRepository.scala) moves temporary files into persistent local directories.
- [`MediaController.scala`](../../src/main/scala/ca/ligature/ohdieux/controllers/MediaController.scala) supports byte-range audio responses. The dynamic admin page can trigger full/incremental refreshes, archive rescans, archive-stat recomputation, suspension, and resumption.
- [`src/main/public`](../../src/main/public/) contains only four assets (about 300 KiB total in this checkout). Media archival is optional but explicitly documented as needing “a large amount of hard drive space” in [`DEPLOYMENT.md`](../DEPLOYMENT.md).

## Product fit

### Workers: HTTP/RSS and admin fit, background actors do not

A TypeScript Worker can implement the existing request/response routes and make HTTPS `fetch()` calls to Radio-Canada. XML and HTML are ordinary streamed `Response` bodies. The current 30-minute RSS caching intent can be preserved, but the migration should explicitly test cache behavior for every query-option variant instead of assuming that `Cache-Control` alone eliminates D1 reads.

The free plan permits [100,000 Worker requests per day, 10 ms CPU per HTTP invocation, 128 MB per isolate, 50 external subrequests per invocation, 1,000 internal-service subrequests, and six simultaneous outgoing connections](https://developers.cloudflare.com/workers/platform/limits/). HTTP response duration has no hard wall-clock limit while the client remains connected, but post-response `waitUntil()` work has only [30 seconds](https://developers.cloudflare.com/workers/platform/limits/#duration). Cloudflare's current best practices accordingly say to [stream large bodies, use bindings, and move retryable/background work to Queues or Workflows](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).

Consequences:

- The RSS and admin handlers are plausible but **10 ms CPU is an acceptance-test gate**, especially for a 500-episode feed, segment expansion, text cleanup, XML serialization, and the all-programmes admin statistics page.
- One invocation cannot perform an initial 500-episode scrape: page fetches plus per-episode playback/media lookups can exceed the 50-external-subrequest ceiling. Each message must process a bounded page or episode and enqueue continuation work.
- Missing-feed auto-add and every admin POST should enqueue durable work and return the same immediate response. They must not recreate fire-and-forget actors with an untracked promise.
- The process-local fixed-rate timer has no serverless equivalent; use Cron. Mutable actor state must become explicit D1/R2 state or message payloads.

Workers has first-class TypeScript support, but Node compatibility is not a server. The current [`node:child_process` is a non-functional stub](https://developers.cloudflare.com/workers/runtime-apis/nodejs/), so FFmpeg/wget subprocesses cannot run. Workers' virtual filesystem provides a read-only bundle and request-local `/tmp`; `/tmp` [is memory-backed, non-persistent, unique to one request, and counts against the 128 MB memory limit](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/). It cannot replace the SQLite file or archive directories.

### D1: correct metadata store, with indexing and quota-sensitive reads

D1 is SQLite-compatible and can directly represent the current tables and upserts. Cloudflare supports [importing an existing SQLite 3 database via a SQL dump and exporting D1 back to SQL](https://developers.cloudflare.com/d1/best-practices/import-export-data/), and its migration files provide the required versioned schema history. Application code must use the D1 binding rather than JDBC or a local database file.

The free plan includes [5 million rows read per day, 100,000 rows written per day, and 5 GB total account storage](https://developers.cloudflare.com/d1/platform/pricing/), but an individual free database is limited to [500 MB; free accounts may have 10 databases, and a Worker may issue at most 50 D1 queries per invocation](https://developers.cloudflare.com/d1/platform/limits/). Reaching a daily read/write limit makes subsequent D1 queries fail until reset; billing counts rows scanned, not rows returned, and indexes reduce scans while adding index writes.

Fit implications:

- One database is enough structurally, but the effective application ceiling is 500 MB, not the account's 5 GB.
- Add indexes for the actual access paths (`episodes.programme_id`, `media.episode_id`, the episode/media ordering key, and status lookups). Verify every migration query with D1's `meta.rows_read`/`rows_written` rather than estimating from result counts.
- A naive RSS port loads every episode/media row before applying `limit_episodes`; that preserves current code structure but wastes the free read budget. Push safe limit/filter work into SQL while preserving ordering and option semantics.
- Hourly idempotent upserts and manual full refreshes consume rows written, with every indexed write adding usage. Queue retries must use the existing stable programme, episode, and media IDs so duplicate delivery remains harmless.
- RSS traffic is the principal read risk: each uncached full-feed request reads data proportional to the programme's stored episodes and media segments. Free-tier fit therefore depends on measured feed size, cache hit rate, and traffic; it cannot be certified from this repository alone.

### R2: correct object store and range server, not free unbounded archival compute

R2 bindings accept a `ReadableStream` for `put`, return a stream from `get`, and support [conditional and ranged reads using request headers](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/). This can preserve image storage and `/media/audio/...` range behavior without buffering objects in Worker memory. Use the binding, attach correct content metadata, and stream responses. A production public bucket should use a [custom domain; `r2.dev` is explicitly non-production](https://developers.cloudflare.com/r2/buckets/public-buckets/).

R2 Standard currently includes [10 GB-month storage, 1 million Class A operations, 10 million Class B operations, and free Internet egress each month](https://developers.cloudflare.com/r2/pricing/). A single-part upload is limited to [5 GiB and an object to 5 TiB (multipart required above the single-part limit)](https://developers.cloudflare.com/r2/platform/limits/). Each archived write is Class A and each uncached object read is Class B.

Images and modest read traffic are likely to fit, but there is no repository data to size them. Media archival is fundamentally conditional: the existing application deliberately has no retention limit, while the free storage allowance is 10 GB-month. No architecture can preserve indefinite growth and guarantee zero cost.

A progressive upstream response could be streamed directly into R2 without buffering. That is **changed behavior**, not a faithful port of FFmpeg's stream-copy/remux, and does not handle an HLS-only result. A Queue consumer also has a [15-minute wall-clock limit](https://developers.cloudflare.com/queues/platform/limits/), so even direct copies need retry/idempotency behavior for slow transfers.

### Cron Triggers: one trigger fits the default schedule

Cron Triggers invoke a Worker's `scheduled()` handler and [run in UTC](https://developers.cloudflare.com/workers/configuration/cron-triggers/). The free plan permits [five Cron Triggers per account](https://developers.cloudflare.com/workers/platform/limits/#account-plan-limits), so one hourly trigger is comfortably within the product-count limit.

The handler must only select eligible programme IDs and enqueue bounded tasks. It must not scrape them itself: free Cron invocations have [10 ms CPU, 15 minutes wall time, and the same subrequest constraints](https://developers.cloudflare.com/workers/platform/limits/#cpu-time).

The default 3,600-second interval maps to an hourly cron expression. The current setting also accepts `0` and arbitrary second intervals; Cron's five-field expressions operate at minute granularity. The migration specification must either narrow this configuration to “disabled or cron expression/minute-granularity interval” or explicitly accept that arbitrary-second scheduling is not preserved.

### Queues: required for bounded fan-out, but budget it as operations

Queues are the best replacement for actor mailboxes and immediate admin/auto-add background work. They provide [at-least-once delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees/), so all handlers need deterministic task IDs and idempotent D1/R2 writes.

The free plan includes [10,000 operations per day and fixed 24-hour retention](https://developers.cloudflare.com/queues/platform/pricing/). A sub-64 KB message normally costs three operations (write, read, delete), yielding at most about 3,333 successful no-retry deliveries per day; retries consume additional reads. Messages are limited to [128 KB, batches to 100 messages, and consumers to 15 minutes wall time](https://developers.cloudflare.com/queues/platform/limits/). Consumer Workers retain the free Worker's 10 ms active-CPU limit.

Payloads should therefore contain IDs/cursors, never upstream JSON or media. As a lower-bound planning formula, emitting one programme-refresh message every hour costs `72 × tracked-programmes` operations/day before page, episode, archive, and retry messages. At 100 programmes that is 7,200 operations/day before useful fan-out; at 139 programmes it already exceeds 10,000. Actual fit must be measured against expected tracked-programme count and incremental-new-episode rate.

One queue with typed messages is sufficient unless later throughput or failure-isolation evidence justifies more products. Bound each consumer to one page, episode, image, direct-copy object, or aggregate shard; acknowledge only after durable D1/R2 effects.

### Workflows: compatible but not justified in the baseline

Workflows offers durable, individually retryable multi-step execution, but Ohdieux's decomposition is mostly fan-out plus idempotent one-step tasks. On the free plan Workflows allows [3,000 steps/day, 1 GB-month state, and shares the 100,000 daily execution/request allowance](https://developers.cloudflare.com/workflows/reference/pricing/). Each free step gets [10 ms CPU; an instance gets 50 external subrequests, at most 1,024 steps, 100 MB persisted state, and three-day completed-state retention](https://developers.cloudflare.com/workflows/reference/limits/).

Those limits do not rescue a monolithic scrape or FFmpeg archive. Workflows may be reconsidered only if a later design identifies a genuinely dependent multi-step operation whose persisted checkpoints are worth the extra quota/product. Queue messages plus D1 state are enough for the currently observed behavior.

### Static Assets: direct fit

Workers Static Assets can serve the current four-file public directory. Static-asset requests are [free and unlimited and asset storage has no additional charge](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/). Free Workers allow [20,000 files per version and 25 MiB per file](https://developers.cloudflare.com/workers/platform/limits/#static-assets), far above this checkout's four files and sub-megabyte largest asset. Keep RSS/admin/media routes Worker-first, but do not configure `run_worker_first` broadly enough to turn ordinary asset hits into metered Worker requests.

## Required specification constraints and acceptance evidence

The migration plan should encode these constraints rather than treating them as implementation details:

1. **Cloudflare product baseline:** Worker + D1 + R2 Standard + one Cron + one Queue + Static Assets; no Workflow without a new decision.
2. **Task boundaries:** every upstream page/episode/archive task is bounded below 50 external subrequests and is safe under duplicate delivery. Cron only fans out.
3. **Data/query design:** versioned D1 migrations, indexed access paths, SQL-level pagination/filtering, stable IDs, and measured `rows_read`/`rows_written` for RSS, hourly refresh, full refresh, rescan, and stats recomputation.
4. **Streaming:** never buffer media in Worker memory. R2 upload/download uses streams and audio responses preserve Range/conditional headers.
5. **Behavioral checks:** preserve the first unknown-feed `404` plus asynchronous add, all RSS option combinations/order/GUIDs/cache headers, unauthenticated admin responses, failed-programme suspension, upstream fallback order, and image/audio route shape.
6. **Free-tier load tests:** with a representative 500-episode multi-segment programme, record CPU for RSS/admin and each consumer, external/internal subrequests, D1 row usage, Queue operations, R2 operations/storage, and object transfer duration. Passing means every invocation is below the cited hard limit and modeled daily/monthly usage is below each included allowance with retry headroom.
7. **Failure tests:** duplicate Queue delivery, expiry/backlog, upstream timeout/parse failure, D1 quota error, R2 write/read failure, object already present, partial direct copy, and Cron overlap.

## Decisions exposed by this research

- **Media archival contract:** disable it on Cloudflare (preserving the existing default), redefine it as direct progressive-byte archival with explicit HLS exclusion, or abandon the Cloudflare-only/free-tier constraint for archival compute.
- **Scheduling contract:** preserve only disabled/hourly-or-cron-compatible schedules, or specify a different mechanism for arbitrary-second intervals.
- **Free-tier promise:** treat “free tier” as a tested deployment envelope with documented capacity, not a guarantee under arbitrary RSS traffic, tracked-programme count, or unbounded archive growth.

No migration code or configuration is changed by this research.
