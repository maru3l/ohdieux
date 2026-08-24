# TypeScript framework fit on Cloudflare Workers

Research date: 2026-08-19

Related work: [Compare TypeScript framework fit on Workers](https://github.com/maru3l/ohdieux/issues/5), part of [Specify the TypeScript migration to Cloudflare Workers](https://github.com/maru3l/ohdieux/issues/2).

## Decision

Use **Hono as a thin HTTP and event adapter around a framework-independent TypeScript core**. Keep the public page in Workers Static Assets, render the small unauthenticated admin page with Hono JSX or an equally small pure HTML renderer, and emit RSS from a pure XML renderer through an explicit `Response`. Put scheduled scraping behind the same application interfaces and invoke it from the Worker's `scheduled` handler.

Treat **actual Express on Workers** as the fallback if direct Express route familiarity is valued more than a Web-standards boundary. Do not choose Astro or Next.js for this migration unless a separately approved UI requirement makes their rendering models valuable enough to justify their adapter and build complexity.

This is a framework decision, not a complete platform decision. D1/R2 schemas, scraping work partitioning, and the archival/transcoding incompatibility still need explicit specifications.

## Scope and constraints

The comparison applies the destination and constraints in [Specify the TypeScript migration to Cloudflare Workers](https://github.com/maru3l/ohdieux/issues/2): strict observable and data compatibility; a portable core with Cloudflare production adapters and in-memory test adapters; maintainer familiarity with Express, React, Next.js, Astro, and TypeScript; minimal Cloudflare products; and operation within free allowances.

It compares these concrete current paths:

1. Next.js on Workers through Cloudflare's documented `@opennextjs/cloudflare` path.
2. Astro on Workers through `@astrojs/cloudflare`.
3. Express itself through Workers' Node HTTP compatibility bridge.
4. Hono as the minimal Workers-native TypeScript framework.

Framework facts and project recommendations are separated below. Sources are first-party framework documentation, Cloudflare documentation, and this repository's application source.

## Application shape to preserve

### HTTP and UI

The Play route table exposes `GET /health`, one query-driven `GET /rss`, an unauthenticated admin page plus four POST action shapes, archived image/audio GETs, static files, and `/` ([routes](../../src/main/resources/routes)). The public UI is static HTML and browser JavaScript that constructs the RSS URL and QR code; it is not currently a React application ([public index](../../src/main/public/index.html)). The admin UI is server-rendered HTML with HTMX buttons plus one small `fetch` handler, not an SPA ([admin template](../../src/main/twirl/views/dashboard/index.scala.html)).

`GET /rss` returns `application/xml`, `404 "not found"` when no manifest exists, and `Cache-Control: max-age=1800, stale-if-error=86400`; its five active boolean options and deprecated `favor_aac` option affect exact feed output ([controller](../../src/main/scala/ca/ligature/ohdieux/controllers/ManifestController.scala), [renderer](../../src/main/scala/ca/ligature/ohdieux/services/manifest/render/ManifestRenderer.scala), [XML template](../../src/main/twirl/views/manifest.scala.xml)). A missing programme can also trigger an asynchronous scrape before the request still returns not found, so strict compatibility includes that side effect and timing ([manifest service](../../src/main/scala/ca/ligature/ohdieux/services/manifest/ManifestService.scala)).

### Scraping, persistence, and archival

The application refreshes every known programme on a fixed timer, supports manual incremental/full refresh, discovers programme type, pages through episodes, refreshes media URLs, records failures, and may auto-track a programme first requested through RSS ([programme actor](../../src/main/scala/ca/ligature/ohdieux/actors/scraper/programme/ProgrammeScraperActor.scala), [scraper implementation](../../src/main/scala/ca/ligature/ohdieux/actors/scraper/programme/ProgrammeScraperActorImpl.scala), [media scraper](../../src/main/scala/ca/ligature/ohdieux/actors/scraper/media/MediaScraperActorImpl.scala)). Persistence is already expressed through repository traits for programmes, episodes, media, manifests, configuration, and statistics, which is a useful precedent for a portable core ([programme repository](../../src/main/scala/ca/ligature/ohdieux/persistence/ProgrammeRepository.scala), [episode repository](../../src/main/scala/ca/ligature/ohdieux/persistence/EpisodeRepository.scala), [media repository](../../src/main/scala/ca/ligature/ohdieux/persistence/MediaRepository.scala), [manifest view](../../src/main/scala/ca/ligature/ohdieux/persistence/ManifestRepository.scala)).

Archival currently stores images and media on a persistent filesystem, downloads with `wget`, and invokes `ffmpeg` to copy an upstream stream into an archived file ([archive repository](../../src/main/scala/ca/ligature/ohdieux/actors/file/impl/ArchivedFileRepository.scala), [archive actor implementation](../../src/main/scala/ca/ligature/ohdieux/actors/file/impl/FileArchiveActorImpl.scala)). Audio delivery supports range requests and reports archived media as `audio/mpeg` ([media controller](../../src/main/scala/ca/ligature/ohdieux/controllers/MediaController.scala)). These requirements matter more to the platform adapters than to the HTTP framework.

## Current framework facts

### Next.js via OpenNext

- Cloudflare's current Next.js guide says to deploy Next.js to Workers with the OpenNext adapter, installs `@opennextjs/cloudflare`, points `main` at `.open-next/worker.js`, uses Workers Static Assets, and requires the Workers compatibility configuration generated by the adapter ([Cloudflare Next.js guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/)). The superseded `@cloudflare/next-on-pages` path is therefore not the path to specify.
- The adapter runs Next.js's **Node.js runtime**, transforms Next build output for Workers, and currently supports App Router, Pages Router, route handlers, SSG, SSR, ISR, streaming, middleware, and the listed React features; Node.js middleware remains unsupported ([OpenNext overview](https://opennext.js.org/cloudflare), [Cloudflare support table](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/)).
- Next development uses the Node.js Next dev server, while OpenNext preview runs the output in `workerd`; Cloudflare explicitly says production compatibility should be checked with the preview command ([Cloudflare Next.js guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/)).
- The generated OpenNext worker exports only `fetch`; adding `scheduled` requires a custom Worker entrypoint that reuses the generated fetch handler ([OpenNext custom Worker](https://opennext.js.org/cloudflare/howtos/custom-worker)).
- A static OpenNext site needs neither a queue nor a tag cache. If Next revalidation is adopted, the documented small-site design adds R2 incremental cache, a Durable Object queue, and D1 tag cache; time-based revalidation requires a queue ([OpenNext caching](https://opennext.js.org/cloudflare/caching)). Image optimization is supported through Cloudflare Images rather than by the base Worker alone ([Cloudflare support table](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/)).
- OpenNext calls out the Workers Free compressed bundle limit of 3 MiB versus 10 MiB on Paid, so bundle fit must be measured rather than assumed ([OpenNext overview](https://opennext.js.org/cloudflare), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#worker-size)).

### Astro via its Cloudflare adapter

- Cloudflare's current Astro guide uses `@astrojs/cloudflare` for on-demand rendering on Workers. The adapter defaults to `output: "server"`; individual routes can be prerendered, while a fully prerendered Astro site needs no adapter or Worker code ([Cloudflare Astro guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/astro/)).
- Astro's model renders content at build time or on demand and adds client-side JavaScript only in interactive islands; its official integrations include React ([Cloudflare Astro guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/astro/)). The adapter supports on-demand routes, server islands, actions, and sessions ([Astro Cloudflare adapter](https://docs.astro.build/en/guides/integrations-guide/cloudflare/)).
- Astro endpoints return Web `Response` objects and can therefore return XML, custom status codes, and exact headers without rendering a page ([Astro endpoints](https://docs.astro.build/en/guides/endpoints/)).
- With the current adapter, on-demand routes always run in `workerd`; current Astro development/preview also uses `workerd`, improving production fidelity ([Astro Cloudflare adapter](https://docs.astro.build/en/guides/integrations-guide/cloudflare/#cloudflare-runtime)).
- Astro sessions automatically provision Workers KV, but the adapter documentation says disabling sessions excludes that runtime and prevents KV provisioning ([Astro Cloudflare adapter](https://docs.astro.build/en/guides/integrations-guide/cloudflare/#sessions)). Ohdieux has no current session behavior, so KV is not inherent to an Astro choice.

### Express through Workers' Node HTTP bridge

- Cloudflare now documents deploying Express itself on Workers: enable Node compatibility, call `app.listen`, and export `httpServerHandler` from `cloudflare:node` ([Cloudflare Express tutorial](https://developers.cloudflare.com/workers/tutorials/deploy-an-express-app/)). This is direct Express support, not an Express-like rewrite.
- `httpServerHandler` adapts a Node HTTP server to the Worker request model. Workers' server-side Node HTTP implementation is not identical to Node: ports are routing keys, trailer headers and 1xx responses are unsupported, socket behavior is limited, and several connection-management methods are absent ([Workers Node HTTP reference](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/)).
- The Express tutorial demonstrates D1 access through a Worker binding and ordinary Express route handlers, so Express does not force a separate database service or HTTP database API ([Cloudflare Express tutorial](https://developers.cloudflare.com/workers/tutorials/deploy-an-express-app/)).
- Cloudflare's documented entrypoint is an adapted Node server. Scheduled execution is still a standard Worker `scheduled` handler, so combining HTTP and schedules requires Worker-entrypoint glue rather than an Express primitive ([Express tutorial](https://developers.cloudflare.com/workers/tutorials/deploy-an-express-app/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)).

### Hono as the minimal Workers-native framework

- Hono's Cloudflare starter exports the Hono application directly as a Worker fetch handler; the same module can export `app.fetch` together with a standard `scheduled` handler, and static files are delegated to Workers Static Assets ([Hono on Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)). No runtime translation adapter is shown in that deployment path.
- Hono is based on Web `Request`, `Response`, `Headers`, and URL APIs and documents the same application model across Workers and other Web-standard runtimes, with a Node adapter also available ([Hono Web Standards](https://hono.dev/docs/concepts/web-standard)). This is portability of the HTTP shell, not a substitute for keeping persistence and archival behind project-owned interfaces.
- Hono can render server-side JSX through `c.html()` and its JSX renderer, while Workers Static Assets can serve the existing static page without invoking Worker code on matching asset requests ([Hono JSX](https://hono.dev/docs/guides/jsx), [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)). Hono JSX is not React and should not be represented as React compatibility.
- Hono tests can call `app.request()` with Web requests and inject a mock environment as the third argument ([Hono testing](https://hono.dev/docs/guides/testing)). Cloudflare's Vitest integration separately runs unit/integration tests in `workerd`, exposes bindings, uses isolated per-test-file storage, and stays local through Miniflare ([Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)).

## Fit assessment

| Constraint | Hono | Express on Workers | Astro | Next.js/OpenNext |
|---|---|---|---|---|
| Exact Play-like HTTP surface | **Strong.** Direct routes and raw `Response`; no page model imposed. | **Strong.** Familiar route and response APIs; Node HTTP bridge is an extra semantic layer. | **Strong.** Endpoints handle raw responses, but file routing and adapter surround a mostly service-oriented app. | **Capable.** Route handlers handle the surface, but Next application conventions surround a mostly service-oriented app. |
| Static public UI | **Strong.** Serve unchanged via Static Assets. | **Strong.** Serve via Static Assets rather than Express. | **Strongest if UI grows.** Prerender by default and add islands selectively. | **Strong but unnecessary today.** React/Next rendering is much more than the current static page needs. |
| Small server-rendered admin UI | **Strong.** Small JSX/HTML renderer matches current HTMX shape. | **Strong.** Choose any small template/HTML renderer. | **Strong.** Natural page rendering, optional React island. | **Strong.** Natural React page, but no current need for an application-sized client UI. |
| RSS XML and strict behavior | **Strong.** Pure renderer can return exact XML/status/headers. | **Strong.** Ordinary response body and headers. | **Strong.** Endpoint returns a raw `Response`. | **Strong.** Route handler returns a raw `Response`. |
| Scheduled scraping | **Strongest.** `fetch` and `scheduled` are first-class exports in one thin module. | **Viable with glue.** Cron sits outside Express. | **Viable with custom entrypoint.** Keep job logic outside page components. | **Viable with custom entrypoint.** OpenNext documents the extra wrapper. |
| Portable core and in-memory adapters | **Strongest fit.** Web-standard shell and direct request testing reinforce a narrow boundary. | **Good if Express stays only at the edge.** Express request/response types must not enter core use cases. | **Good if Astro context stays only at the edge.** Framework page conventions offer no core benefit. | **Weakest.** Next server/cache conventions create more opportunities for framework concerns to enter core code. |
| Minimal Cloudflare products | **Best.** Framework itself needs only the Worker; Static Assets, Cron, D1, and optional R2 follow application needs. | **Tied.** Same product floor as Hono. | **Tied if sessions are disabled.** Otherwise KV is automatically introduced. | **Worst if Next cache/image features are used.** Revalidation and image optimization can add R2, Durable Objects, D1, queues, or Images. |
| Free-plan risk | **Lowest framework risk.** Thin direct runtime path leaves the most room under CPU and bundle limits. | **Moderate.** Measure Node bridge/framework bundle and CPU overhead. | **Moderate.** Measure adapter/render bundle and CPU overhead. | **Highest.** OpenNext explicitly warns about the 3 MiB Free bundle ceiling; SSR and cache features add moving parts. |
| Maintainer familiarity | Express-like routing is approachable but Hono is a new API. | Highest direct routing familiarity. | High stated familiarity and best UI-growth path. | High stated familiarity and strongest React path. |

The qualitative ratings are recommendations derived from the cited framework facts and Ohdieux's cited application shape; they are not vendor claims.

## Recommendation rationale

### Why Hono

1. **The migration is service-heavy, not UI-heavy.** The observable surface is a handful of routes, exact RSS XML, a static page, and a small HTMX admin page ([routes](../../src/main/resources/routes), [public index](../../src/main/public/index.html), [admin template](../../src/main/twirl/views/dashboard/index.scala.html)). Hono supplies routing and small HTML rendering without making React, a page build graph, or a server-component model part of the migration.
2. **It creates the cleanest portable boundary.** Define core use cases in terms of project-owned values and interfaces; let Hono translate `Request`/route parameters to those values and translate outcomes back to `Response`. Hono's Web-standard model and injectable test environment support that boundary ([Hono Web Standards](https://hono.dev/docs/concepts/web-standard), [Hono testing](https://hono.dev/docs/guides/testing)).
3. **It matches Worker events directly.** HTTP and scheduled handlers can share composition without hiding cron behind a page framework or generated adapter ([Hono Workers guide](https://hono.dev/docs/getting-started/cloudflare-workers), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)).
4. **It does not select extra Cloudflare products.** Static Assets serve public files, Cron replaces the actor timer, D1 is the likely SQLite-compatible production repository, and R2 is needed only if archival remains in scope; Hono itself adds none of these bindings ([Static Assets](https://developers.cloudflare.com/workers/static-assets/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)).

### Why not Express as the default

Express is now a credible fallback because Cloudflare officially documents direct deployment through `httpServerHandler` ([Express tutorial](https://developers.cloudflare.com/workers/tutorials/deploy-an-express-app/)). It maximizes familiar routing and would still permit a portable core if no Express type crosses the application boundary.

Hono is preferred because it uses the Worker's request/event model directly, while Express adds a Node HTTP compatibility translation with documented behavioral gaps and leaves cron outside Express ([Workers Node HTTP reference](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)). Ohdieux has no existing Express middleware investment to preserve, so the bridge buys familiarity rather than compatibility with existing code.

### Why not Astro as the default

Astro is the best alternative if the plan changes toward a content-rich or incrementally interactive UI: it can prerender the public page, server-render admin, add React islands, and implement XML endpoints ([Cloudflare Astro guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/astro/), [Astro endpoints](https://docs.astro.build/en/guides/endpoints/)).

That is not the current application. Selecting Astro would make a page framework and Cloudflare adapter the outer application shell while the hard requirements remain scraping, exact RSS rendering, repositories, scheduling, and archival. It offers no compensating advantage for those core requirements.

### Why not Next.js/OpenNext

Next.js can implement every HTTP/UI requirement, and OpenNext is now the current documented Workers adapter ([Cloudflare Next.js guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/)). It is still the poorest fit for this migration because the current UI does not need React server components or Next's rendering/cache model, cron requires a custom generated-worker wrapper, production tests must account for Node-dev versus `workerd` preview, and the adapter specifically flags the 3 MiB Free bundle limit ([OpenNext custom Worker](https://opennext.js.org/cloudflare/howtos/custom-worker), [Cloudflare Next.js guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/), [OpenNext overview](https://opennext.js.org/cloudflare)). Using ISR or image optimization would also work against the minimal-product constraint by introducing additional Cloudflare facilities ([OpenNext caching](https://opennext.js.org/cloudflare/caching), [Cloudflare support table](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/)).

## Required architectural guardrails for the later specification

These are recommendations, not framework facts:

- Keep Hono imports in the delivery layer. Core scraping, manifest rendering, status transitions, and archive policy must accept project-owned inputs and ports only.
- Define production ports for programme/episode/media/config/statistics persistence, object storage, upstream Radio-Canada HTTP, clock, and job dispatch. Supply Cloudflare adapters in production and deterministic in-memory adapters in tests.
- Preserve RSS with byte- or structure-level golden tests covering status, content type, cache header, XML escaping/order, date formatting, every query option, segment ordering/tagging, replay exclusion, the 50-episode limit, archived URL substitution, and the initial `404` plus scrape side effect. The behaviors to preserve are in the existing controller, renderer, service, and XML template ([controller](../../src/main/scala/ca/ligature/ohdieux/controllers/ManifestController.scala), [renderer](../../src/main/scala/ca/ligature/ohdieux/services/manifest/render/ManifestRenderer.scala), [service](../../src/main/scala/ca/ligature/ohdieux/services/manifest/ManifestService.scala), [template](../../src/main/twirl/views/manifest.scala.xml)).
- Serve the public UI and bundled images/scripts as Workers Static Assets. Keep Worker-first routing limited to dynamic paths so matching assets do not invoke Worker code ([Workers Static Assets routing](https://developers.cloudflare.com/workers/static-assets/)).
- Run integration/compatibility tests in `workerd`, not only against a Node test server. Cloudflare's Vitest pool executes locally inside the Workers runtime with isolated storage ([Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)).
- Generate Cloudflare binding types from Wrangler configuration rather than hand-writing them, as both Cloudflare's framework guides and Hono's Workers guide document ([Cloudflare Next.js guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/), [Hono Workers bindings](https://hono.dev/docs/getting-started/cloudflare-workers#generating-bindings-types-automatically)).

## Free-tier and platform findings that no framework resolves

### Compute and bundle budget

Workers Free currently allows 100,000 dynamic requests per day, 10 ms CPU per HTTP or Cron invocation, 3 MiB compressed Worker code, 128 MB memory, and five Cron Triggers per account; static asset requests are free and unlimited ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/#workers), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). Network wait time does not count as CPU, but parsing upstream payloads, assembling episode state, database result processing, and RSS rendering do ([Workers CPU limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)).

Therefore, **free-tier fit is conditional and must be measured**. Hono minimizes avoidable framework work, but the present serial scraper can process many episodes and media records in one refresh ([programme scraper](../../src/main/scala/ca/ligature/ohdieux/actors/scraper/programme/ProgrammeScraperActorImpl.scala), [media scraper](../../src/main/scala/ca/ligature/ohdieux/actors/scraper/media/MediaScraperActorImpl.scala)). A later specification must define bounded, restartable work units or explicitly accept that larger refreshes can exceed Free CPU; changing frameworks cannot remove this constraint.

D1 Free currently includes 5 million rows read/day, 100,000 rows written/day, and 5 GB total storage; exceeding a daily operation limit causes D1 operations to fail until reset ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)). Indexed queries and measured compatibility fixtures are therefore part of free-tier validation, not reasons to choose a UI framework.

### Archival and transcoding

R2 can accept a `ReadableStream`, return object bodies as streams, and perform ranged reads; its free allowance is 10 GB-month, 1 million Class A operations, and 10 million Class B operations per month with free Internet egress ([R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/)). This fits direct image/object copying and range-capable delivery while usage remains under the allowance.

It does **not** reproduce the current `ffmpeg` operation. Workers' `node:child_process` is a non-functional stub, and the writable virtual filesystem is request-local, memory-backed, non-persistent, and counted against Worker memory ([Workers Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/), [Workers virtual filesystem](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/)). The current implementation explicitly shells out to `ffmpeg` before moving the file to persistent archive storage ([archive implementation](../../src/main/scala/ca/ligature/ohdieux/actors/file/impl/FileArchiveActorImpl.scala)).

The migration specification therefore needs a separate keep/change decision for archived HLS media: retain only upstream objects that can be copied without transcoding, change archival behavior, disable media archival, or accept another compute product/runtime. Adding a process-capable product solely for `ffmpeg` would conflict with the current minimal-products and free-tier constraints; this research does not choose that trade-off.

## Decision summary

- **Choose:** Hono as the thin Worker-native delivery/event framework.
- **Keep portable:** pure TypeScript core plus project-owned ports; Cloudflare production adapters and in-memory test adapters.
- **UI:** Static Assets for the current public page; small server-rendered HTML/Hono JSX for admin; do not introduce React unless a later UI requirement justifies it.
- **Compatibility:** pure RSS XML rendering with golden behavior tests; no framework rendering abstraction in the feed path.
- **Fallback:** Express through Cloudflare's official Node HTTP bridge if route familiarity is explicitly prioritized.
- **Do not choose by default:** Astro or Next.js/OpenNext for the current service-dominant application.
- **Unresolved adjacent decisions:** bounded scheduled scraping under the 10 ms Free CPU limit, and archival behavior where the Scala implementation depends on `ffmpeg`.
