# Observable compatibility contract

This document inventories the observable contract of the Scala/Play implementation at commit `5d5072e`. It is the compatibility baseline for the one-shot TypeScript migration. Unless a later migration decision explicitly grants an exception, the replacement must preserve the behaviors below.

“Confirmed” means established from source or by characterizing a production image built from the baseline commit. “Legacy edge” means current behavior is confirmed but may be accidental; it must not be silently corrected. There is no active application test suite: `build.sbt` declares ScalaTest, but the only test-like Scala file is a Giter8 template under `.g8/`.

## HTTP interface

The complete route table is in [`src/main/resources/routes`](../../src/main/resources/routes).

| Request | Inputs | Success | Missing resource or invalid input | Side effect |
| --- | --- | --- | --- | --- |
| `GET /health` | None | `200`, `text/plain; charset=UTF-8`, body `healthy` | — | None |
| `GET /rss` | Required query `programme_id: Int`; optional query booleans `reverse`, `tag_segments`, `limit_episodes`, `exclude_replays`, `favor_aac` | Existing programme: `200 application/xml` with `Cache-Control: max-age=1800, stale-if-error=86400` | Unknown programme: `404 text/plain`, body `not found`; malformed binding: `400`, body `an error occurred` | An unknown programme is queued for discovery when auto-add is enabled, but this response remains `404` |
| `GET /admin` | None | `200 text/html; charset=UTF-8` | Query/render failure: `500`, body `error` | Synchronously reads dashboard statistics |
| `POST /admin/refresh` | Required query `programme_id`; optional query `incremental`, default `true` | `200 text/plain`, body `ok` | Malformed binding: `400`, body `an error occurred` | Queues a scrape; acknowledgement does not imply scrape success |
| `POST /admin/rescan` | Required query `programme_id` | `200 text/plain`, body `ok` | Malformed binding: `400`, body `an error occurred` | Queues archival retries using stored media URLs |
| `POST /admin/recompute-stats` | None | `200 text/plain`, body `ok` | — | Queues full archive-stat recomputation |
| `POST /admin/programme/:programme_id/status` | Integer path; required query `status`; optional query `msg` | Exact statuses `Ok` and `Failed`: `200 text/plain`, body `ok` | Invalid status spelling or case: `500`, body `error`; malformed ID: `400` | Queues status update; omitted `msg` becomes `Manually suspended by admin.` for either status |
| `GET /media/image/:programme_id` | Integer path | Existing archive: `200 image/jpeg`, exact bytes | Missing archive: `404 text/plain` with an empty body; malformed ID: `400` | None |
| `GET /media/audio/:media_file` | One path segment | Existing archive: ranged attachment described below | Missing archive: `404 text/plain`, body `not cached`; invalid filename: `500`, body `error` | None |
| `GET /*file` | Public asset path | Serves the matching classpath asset | Missing asset: `404`, body `not found` | None |
| `GET /` | None | Serves `public/index.html` | — | None |

Controller evidence: [`HealthController.scala`](../../src/main/scala/ca/ligature/ohdieux/controllers/HealthController.scala), [`ManifestController.scala`](../../src/main/scala/ca/ligature/ohdieux/controllers/ManifestController.scala), [`AdminController.scala`](../../src/main/scala/ca/ligature/ohdieux/controllers/AdminController.scala), [`MediaController.scala`](../../src/main/scala/ca/ligature/ohdieux/controllers/MediaController.scala), and [`DefaultErrorHandler.scala`](../../src/main/scala/ca/ligature/ohdieux/infrastructure/DefaultErrorHandler.scala).

### Framework-level request and error behavior

Characterization of the baseline Play image confirms:

- `HEAD` executes the matching `GET` route and suppresses the body.
- `OPTIONS` and unsupported methods return `404 not found`; there is no CORS handling.
- Unmatched paths return `404 not found`.
- Missing, invalid, or overflowing bound route parameters return `400 an error occurred`.
- Uncaught controller exceptions return `500 error`.
- Form-encoded and JSON bodies do not satisfy route query parameters. Otherwise, admin request bodies are ignored.
- Unknown query parameters are ignored.
- Duplicate query parameters use the first value.
- Normal and error responses inherit Play’s `Referrer-Policy`, `X-Frame-Options`, `X-XSS-Protection`, `X-Content-Type-Options`, and `X-Permitted-Cross-Domain-Policies` defaults. `Date`, validators, and other runtime-generated values are not byte-stable.
- CSRF and allowed-host filtering are disabled. The admin interface is intentionally unauthenticated in this migration’s baseline ([`application.conf`](../../src/main/resources/application.conf), [`docs/DEPLOYMENT.md`](../DEPLOYMENT.md)).

The Play boolean binder accepts trimmed `true`, `false`, `1`, `0`, and an empty value. `1` means true; `0` and empty mean false. `TRUE`, `False`, `yes`, `on`, and arbitrary text return `400`. Missing RSS option booleans default false; missing `incremental` defaults true.

### Audio file names and ranges

`media_file` has one exact terminal `.m4a` removed and the remainder is parsed as a signed 32-bit integer. Both `1002` and `1002.m4a` address media 1002. `1002.mp4` and `abc.m4a` cause `500 error`.

For an existing 16-byte archive:

| `Range` | Result |
| --- | --- |
| absent | `200`, `Accept-Ranges: bytes`, `Content-Disposition: attachment; filename="<id>.m4a"`, full body |
| `bytes=0-3` | `206`, `Content-Range: bytes 0-3/16`, bytes 0–3 |
| `bytes=4-` | `206`, bytes 4–15 |
| `bytes=-4` | `206`, bytes 12–15 |
| malformed or unsatisfiable | `416`, `Content-Range: bytes */16`, empty body |
| `bytes=0-1,4-5` | `206`, one collapsed span containing bytes 0–5, not multipart output |

The response content type is `audio/mpeg` even though archives are stored as `.mp4` and exposed as `.m4a`.

## RSS interface

### Selection and ordering

The manifest query is defined in [`DatabaseManifestRepository.scala`](../../src/main/scala/ca/ligature/ohdieux/persistence/impl/DatabaseManifestRepository.scala).

- A stored programme produces a feed even when it has no joined episodes.
- A missing programme produces no manifest.
- Episodes without media are omitted by inner joins across `episodes`, `media`, and `programmes`.
- Episodes are ordered by numeric `episode_id DESC`, not publication date.
- Media within an episode are ordered by `episode_index ASC`.
- Every media row becomes one RSS `<item>`; a multi-segment episode therefore appears multiple times.
- A segment GUID is `<episodeId>_<zero-based-position-after-media-sort>`.

### Text and dates

[`CleanTextUtils.scala`](../../src/main/scala/ca/ligature/ohdieux/services/manifest/render/CleanTextUtils.scala) and [`ManifestRenderer.scala`](../../src/main/scala/ca/ligature/ohdieux/services/manifest/render/ManifestRenderer.scala) apply this order to programme title, description, and author and to episode title and description:

1. Replace exact lowercase `<br>` and `<br/>` with one space.
2. Remove substrings matching `<[^<]+?>`.
3. Unescape HTML4 entities.
4. Let Twirl’s XML template escape the resulting text.

Exact compatibility includes the narrow handling of `<BR>`, `<br />`, malformed markup, and nested markup. Stored `&amp;` is unescaped and then XML-escaped once.

Stored programme and episode date strings are parsed as `ZonedDateTime` and rendered with RFC 1123 formatting. UTC is emitted as `GMT`; other offsets are retained. An invalid stored date causes `500 error`.

### Exact document shape

[`manifest.scala.xml`](../../src/main/twirl/views/manifest.scala.xml) fixes the channel values and element order.

Channel contract:

- `copyright` and `itunes:author`: cleaned programme author.
- `description` and `itunes:subtitle`: the same cleaned programme description.
- `language`: `fr`.
- `link`: programme canonical URL.
- `lastBuildDate`: formatted `last_checked`.
- `itunes:explicit`: `clean`.
- `itunes:category`: `News`.
- Image URL appears in both `itunes:image` and `<image>`.
- No Atom self link, generator, owner/email, channel GUID, or advertised-episode element is emitted.

Each item contains, in order: enclosure, title, description, GUID, iTunes author, iTunes duration, iTunes explicit, and publication date.

Legacy edges that remain part of the baseline:

- Enclosure `length` is episode duration in seconds, not media byte length or `media.length`.
- iTunes duration is the same integer.
- Enclosure type is hard-coded to `audio/mpeg` regardless of the upstream URL.

### User options

Options are implemented in [`ManifestRenderer.scala`](../../src/main/scala/ca/ligature/ohdieux/services/manifest/render/ManifestRenderer.scala).

- `tag_segments=true` appends `(1)`, `(2)`, and so on using sorted media position.
- `reverse=true` reverses segments inside each episode. It does **not** reverse episode order.
- `limit_episodes=true` takes the first 50 joined episodes before segment expansion. The 50th episode can contribute multiple items.
- `exclude_replays=true` removes every expanded segment of rows with `is_broadcast_replay > 0`; this occurs after limiting and expansion.
- `favor_aac=true` is deprecated. A URL matching the entire pattern `.*/mp4/.*\.mp4$` has every `/mp4/` replaced with `/hls/` and every `.mp4` replaced with `.aac`. Uppercase extensions, query strings, and URLs without `/mp4/` do not match.

Server options:

- `serve_images=true` unconditionally rewrites the image URL to `imageArchiveBaseUrl + programmeId`, whether or not the image file exists.
- `serve_media=true` rewrites an enclosure only when its local archive exists, to `mediaArchiveBaseUrl + mediaId + ".m4a"` and `audio/mpeg`.
- Local media rewriting precedes `favor_aac`, so local `.m4a` URLs are not AAC-rewritten.
- Base URLs are concatenated verbatim without slash normalization.

## Static and admin interfaces

[`src/main/public/index.html`](../../src/main/public/index.html) is a bilingual landing page. Its browser script concatenates the raw programme input into `/rss?programme_id=<value>`, appends only checked true options, and does not URL-encode or validate the programme ID. It writes the browser-resolved absolute URL to the feed link and QR code.

[`dashboard/index.scala.html`](../../src/main/twirl/views/dashboard/index.scala.html) loads HTMX 2.0.3 from unpkg and exposes incremental/full refresh, rescan, suspend, clear-error, and recompute controls. Its add form sends `POST` with query parameters and replaces button text with the response body. Twirl HTML-escapes stored values without applying the RSS text cleaner.

Baseline public assets:

| Path | Bytes | SHA-256 |
| --- | ---: | --- |
| `/` and `/index.html` | 3,286 | `f8e7648343e5cd22859f952cd608bda8b68adf6f927c0764091125e276f797b6` |
| `/favicon.ico` | 14,942 | `c8a76732a4c7c4bdce523858a85caf464d873211ef7428c039d745a2833dcd5b` |
| `/static/instructions.png` | 246,099 | `f1118b9ae72e0c1db92329649d92dfb97feedae57f1418ad7615e44879e5a270` |
| `/static/qrcode.js` | 34,303 | `20aedd71ebf5e39f60a91233f98201f2acf9b1898e98cb542917d368b7dbdfa5` |

Assets use `Cache-Control: max-age=86400`, byte ranges, ETag and Last-Modified validators, and conditional `304` responses. Validator values are deployment artifacts, not stable data, unless parity acceptance later says otherwise.

## Configuration interface

HOCON values and optional environment substitutions are in [`application.conf`](../../src/main/resources/application.conf). Later assignments override earlier defaults.

| Environment / setting | Default and behavior |
| --- | --- |
| `PORT` / `http.port` | `9000` |
| `HTTP_ADDRESS` / `http.address` | `0.0.0.0` |
| `DATA_DIR` / `base_data_dir` | Empty string; concatenated verbatim |
| `PUBLIC_URL` / `public_url` | Empty string; concatenated verbatim into default media URLs |
| `JDBC_DRIVER` | `org.sqlite.JDBC` |
| `JDBC_URL` | `jdbc:sqlite:${base_data_dir}ohdieux.db` |
| `JDBC_USERNAME`, `JDBC_PASSWORD` | Optional |
| `DATABASE_CONNECTION_POOL_SIZE` | `9` |
| `RC_BASE_URL` | `https://services.radio-canada.ca` |
| `USER_AGENT` | Chrome 130 on Windows user-agent string in config |
| `ARCHIVE_MEDIA` | `false` |
| `ARCHIVE_BASEDIR` | `${base_data_dir}archive` |
| `ARCHIVE_TEMP_DIR` | `/tmp/ohdieux` |
| `ARCHIVE_PROGRAMME_BLACKLIST` | Empty integer sequence |
| `SCRAPER_REFRESH_INTERVAL` | `3600` seconds; zero disables periodic refresh |
| `SCRAPER_MAX_EPISODES` | `500`; zero means unlimited |
| `SCRAPER_AUTO_ADD_PROGRAMME` | `true` |
| `MANIFEST_SERVE_IMAGES` | `false` |
| `MANIFEST_IMAGE_BASE_URL` | `${PUBLIC_URL}/media/image/` |
| `MANIFEST_SERVE_MEDIA` | `false` |
| `MANIFEST_AUDIO_BASE_URL` | `${PUBLIC_URL}/media/audio/` |

Typed configuration errors fail dependency construction/startup rather than being ignored ([`Module.scala`](../../src/main/scala/Module.scala)). The Docker image runs Java 21 as UID/GID 2000, works under `/data`, creates `/data` and `/tmp/ohdieux`, installs FFmpeg and BusyBox wget, and forces `base_data_dir=/data/` ([`Dockerfile`](../../Dockerfile)).

## Boot and scheduled effects

- Archive `images`, `media`, and temporary directories are created while constructing the archive repository; directory creation failure can prevent startup ([`ArchivedFileRepository.scala`](../../src/main/scala/ca/ligature/ohdieux/actors/file/impl/ArchivedFileRepository.scala)).
- Repository construction issues `CREATE TABLE IF NOT EXISTS`; there are no schema evolution files.
- Actor systems are created for programme scraping, media scraping, file archival, archive statistics, and programme configuration ([`Module.scala`](../../src/main/scala/Module.scala)).
- A fixed-rate programme timer starts only when `refresh_interval > 0`. Every tick reads all programmes and queues an incremental fetch for each. Failed programmes are skipped ([`ProgrammeScraperActor.scala`](../../src/main/scala/ca/ligature/ohdieux/actors/scraper/programme/ProgrammeScraperActor.scala)).
- Requesting a missing RSS programme queues `FetchProgramme` only when auto-add is enabled, while returning `404` immediately ([`ManifestService.scala`](../../src/main/scala/ca/ligature/ohdieux/services/manifest/ManifestService.scala)).

## Persistence interface

The replacement must accept and migrate these SQLite-compatible records without semantic loss.

### Tables

- `programmes`: integer primary/unique `id`; type, title, description, author, canonical URL, image URL, advertised episode count, and textual last-checked date. Persisted type strings are exactly `Balado`, `EmissionPremiere`, `GrandeSerie`, and `Audiobook`.
- `episodes`: integer primary/unique `id`; programme ID, title, description, textual date, integer duration, and integer replay flag.
- `media`: integer primary/unique `id`; episode ID, episode index, integer length, and upstream URL; unique `(episode_id, episode_index)`.
- `programme_config`: one row per programme; exact status string, message, and textual date. A missing row is interpreted as `Ok` with empty message/date without inserting a row.
- `archive_stats`: one row per programme with integer `archived_episodes`.

DDL and parsers are in the persistence adapters under [`src/main/scala/ca/ligature/ohdieux/persistence/impl`](../../src/main/scala/ca/ligature/ohdieux/persistence/impl).

### Query and update behavior

- Saves use `INSERT ... ON CONFLICT DO UPDATE` and update every field, including key fields.
- A compound media conflict can replace the existing row’s `id`.
- Full refreshes do not delete disappeared programmes, episodes, media, configuration, or statistics.
- There are no declared foreign keys or cascades.
- Most repository reads have no explicit order. Callers must not depend on accidental SQLite row order unless characterization captures it.
- Dashboard statistics exclude programmes with no episode rows, sort programmes by ID ascending, default missing archive stats to zero, and count episode rows rather than media rows.
- The statistics query uses a full join; an orphan archive-stat row can surface null required programme columns and fail parsing.
- `archived_episodes` actually counts archived media segments. Incremental updates and recomputation both count media handles, not distinct episodes.

The legacy V1 helper [`scripts/import_v1_data.py`](../../scripts/import_v1_data.py) generates SQL without executing it. It infers programme type from URLs, has no audiobook import, escapes apostrophes, discards source timezone while parsing dates, adds one microsecond and `Z`, can synthesize negative media IDs, defaults to `output.sql`, and silently catches each file’s exception. Because output is appended before the broad catch, malformed input can leave partial SQL.

## Radio-Canada upstream interface

[`ApiClient.scala`](../../src/main/scala/ca/ligature/ohdieux/ohdio/ApiClient.scala) makes blocking HTTP `GET` calls with configured `User-Agent` and `Content-Type: application/json`; no explicit retry or timeout is configured. Non-2xx responses become `FetchFailure`. A 2xx response is JSON-decoded and then schema-validated; malformed JSON may throw, while model mismatch becomes `ParseFailure`.

Exact operation names, persisted-query hashes, variables, and endpoint construction are compatibility data in [`Queries.scala`](../../src/main/scala/ca/ligature/ohdieux/ohdio/Queries.scala):

- Programme GraphQL endpoint: `${RC_BASE_URL}/bff/audio/graphql`.
- Type probing order: `Balado`, `EmissionPremiere`, `GrandeSerie`, `Audiobook`; the first successfully decoded type wins.
- Playback-list operation: `playbackListByGlobalId` with `contentTypeId` and string ID. Negative IDs are rejected before I/O.
- Media validation endpoint: `${RC_BASE_URL}/media/validation/v2` with `appCode=medianet`, `connectionType=hd`, `deviceType=ipad`, `idMedia`, `multibitrate=true`, `output=json`, and `tech`.
- Media selection tries `progressive` first and `hls` second, taking the first successfully decoded URL.

When direct media ID is absent, playback-list items are filtered by global ID, mapped to media IDs, and de-duplicated while retaining first occurrence.

## Scraping interface

Programme assembly ([`Assembler.scala`](../../src/main/scala/ca/ligature/ohdieux/actors/scraper/programme/Assembler.scala)):

- Author is always `Radio-Canada`.
- Canonical URL is `https://ici.radio-canada.ca/ohdio` plus the upstream canonical path.
- Image patterns replace `{width}` with `1400` and `{ratio}` with `1x1`.
- Advertised episode count comes from paging metadata.
- `last_checked` is the local `ZonedDateTime.now` in ISO form.
- Episode and media IDs must fit signed 32-bit integers.

Incremental and pagination behavior:

- Incremental refresh saves and processes the current episode and continues only while that current episode was previously unknown. It therefore includes the first already-known episode and then stops.
- `max_episodes=0` is unlimited; otherwise traversal stops at the configured depth.
- A small, normal-order programme is forced to full refresh when advertised count is below ten and `known + 2 < advertised`.
- The order heuristic ignores replay rows. More than two ascending transitions means oldest-to-newest and reverses traversal from the last page; more than two descending transitions means normal traversal; ambiguous cases default normal.
- An all-replay page can throw when the heuristic assumes a non-replay item.
- An empty first page saves programme metadata and then throws on first iteration.
- Advancing after the final item may issue one extra page request.
- A saved programme’s first-page fetch/parse failure can be silently ignored without setting failed status.
- Later pagination failure silently truncates the scrape.
- Thrown failures store `Failed`, the exception message, and the current ISO date. Automatic and manual fetches remain suppressed until status is explicitly changed to `Ok`; success does not independently clear a failed status.
- Missing upstream episode date defaults to `2000-01-01T00:00Z`; missing summary defaults to empty.
- Unknown upstream `typename` can trigger a non-exhaustive match failure.
- Audiobooks become one synthetic page; episode IDs are `-originalId * 1000 - itemIndex`.

These legacy edges are confirmed behavior, not recommended design.

## Archival interface

[`ArchivedFileRepository.scala`](../../src/main/scala/ca/ligature/ohdieux/actors/file/impl/ArchivedFileRepository.scala) defines:

- Image path: `${archive.base_dir}/images/<programmeId>.0.jpg`.
- Media path: `${archive.base_dir}/media/<mediaId>.mp4`.
- Temporary files: random UUID names ending in `.jpg` or `.mp4`.

Images are downloaded with `wget --user-agent <UA> -O <temporary> <URL>`. A successful programme scrape attempts image archival even when `ARCHIVE_MEDIA=false`. Revision-zero images are never replaced once present.

Audio archival:

- Runs only when the file is absent, archival is globally enabled, and the programme is not blacklisted.
- Invokes `ffmpeg -loglevel error -user_agent <UA> -i <URL> -acodec copy <temporary.mp4>`.
- Moves the temporary file to the final path and increments archive statistics.
- Nonzero downloader exit throws, restarts the supervised archive actor, and may leave a temporary file.
- New media always fetches and saves a URL. Existing media refreshes its URL only when archival is globally enabled and the local file is absent.
- The URL-refresh condition ignores the blacklist, so blacklisted programmes can repeatedly refresh upstream URLs while downloads remain skipped.
- Archival is enqueued before the media record is saved; file work and persistence are not transactional.
- Rescan uses stored URLs and does not re-query Radio-Canada.

Cloudflare cannot reproduce the current FFmpeg/HLS path directly. Any changed archival semantics require an explicit compatibility exception rather than an implementation-time substitution.

## Deterministic characterization fixtures

These fixture IDs are the stable vocabulary for parity planning and implementation.

### HTTP-01 — protocol and binding matrix

Against an empty database, capture status, content type, exact stable body, stable headers, and `HEAD` behavior for:

1. `GET` and `HEAD /health`.
2. Unknown path, wrong method, and `OPTIONS`.
3. Every required parameter omitted, nonnumeric, and outside signed 32-bit range.
4. Each boolean as `true`, `false`, `1`, `0`, empty, uppercase, arbitrary text, surrounding whitespace, and duplicate values.
5. Form and JSON bodies without equivalent query parameters.
6. Valid and invalid programme status values.
7. Missing image/media and valid/malformed media file names.

Ignore only dynamic `Date` and server-specific transport headers unless parity acceptance explicitly includes them.

### RSS-01 — canonical feed

Seed programme 42:

```text
id=42
type=Balado
title=A &amp; B <b>show</b>
description=Line<br>Two &amp; <i>Three</i>
author=R&amp;C
canonical_url=https://canonical.example/p
image_url=https://cdn.example/image.jpg
episodes=3
last_checked=2024-01-02T03:04:05Z
```

Seed episodes and media:

```text
episode 102: title="Newest &amp; E", description="D &amp;esc; &lt;x&gt;", date=2024-01-02T01:00:00Z, duration=60, replay=0
  media 1002 index=0 length=111 url=https://cdn.example/mp4/a.mp4
  media 1003 index=1 length=222 url=https://cdn.example/audio/b.mp3
episode 101: title="Replay", description="Replay D", date=2024-01-01T01:00:00Z, duration=50, replay=1
  media 1001 index=0 length=333 url=https://cdn.example/audio/r.mp3
episode 100: title="Oldest", description="Old D", date=2023-12-31T01:00:00Z, duration=40, replay=0
  media 1000 index=0 length=444 url=https://cdn.example/audio/o.mp3
```

Insert media in a deliberately different order. Default expected GUID order is:

```text
102_0, 102_1, 101_0, 100_0
```

The channel title must render as `A &amp; B show` in XML and parse to `A & B show`; its description must parse to `Line Two & Three`. Each enclosure length must equal episode duration (`60`, `60`, `50`, `40`), never seeded media length.

With `reverse=true&tag_segments=true&exclude_replays=true`, expected GUID/title order is:

```text
102_1  Newest & E (2)
102_0  Newest & E (1)
100_0  Oldest (1)
```

Archive only media 1002. With local serving enabled, 1002 must use the local `.m4a` URL while all unarchived media keep upstream URLs.

### RSS-02 — option boundaries

- Seed 51 episodes and give the 50th selected episode three segments. `limit_episodes=true` includes all three segments and omits the 51st selected episode.
- Give one replay multiple segments. Exclusion removes them all.
- Verify AAC transformation for `/mp4/a.mp4`; verify no transformation for an uppercase extension, a query string, or a non-`/mp4/` URL.
- Verify non-UTC RFC 1123 offset retention and malformed stored-date `500`.
- Verify server base URLs with zero, one, and two joining slashes are concatenated unchanged.

### DB-01 — schema and upsert compatibility

1. Capture `sqlite_master` table and index definitions from the baseline.
2. Round-trip every persisted enum string.
3. Exercise primary-key and compound-media conflicts and assert every field update.
4. Assert full refresh does not delete stale rows.
5. Include orphan rows, nulls where SQLite permits them, negative audiobook/media IDs, signed 32-bit boundaries, and malformed date text.
6. Assert missing programme config reads as the implicit `Ok` value without insertion.
7. Open a copied baseline SQLite database read/write with the migration tooling before cutover.

### RC-01 — upstream mock

Record exact method, path, percent-encoded query, stable headers, call order, and persisted result for:

- type probing that succeeds on each of the four types and probing where all fail;
- non-2xx, invalid JSON, schema mismatch, and GraphQL error bodies;
- normal, reversed, all-replay, and empty pagination;
- pagination failure after one successful page;
- direct media ID and playback-list discovery, including duplicate IDs;
- progressive success, progressive failure plus HLS success, and both failing;
- audiobook transformation.

### JOB-01 — asynchronous and scheduled effects

Using a fake clock and inspectable queues, assert:

- Admin routes acknowledge before work completes.
- Missing RSS responds `404` before auto-add work completes.
- Interval zero schedules nothing; positive interval queues incremental refresh for every stored programme.
- Failed programmes are skipped and remain suppressed until set to `Ok`.
- Thrown failures write exact status, message, and controlled clock date.

### ARCHIVE-01 — files, commands, and ranges

With fixed byte files and a stub command runner, assert:

- image download while audio archival is disabled;
- revision-zero image nonreplacement;
- every global archive-toggle/blacklist/file-exists combination;
- exact FFmpeg and wget argument ordering;
- temporary and final path patterns;
- existing-file idempotency and failure residue;
- archive-stat increment and recomputation by media segment;
- the complete 16-byte range matrix in the HTTP section.

### UI-01 — static and dashboard surface

- Compare the four public asset hashes above.
- Characterize cache, range, and conditional-request behavior while normalizing deployment-generated validators.
- Render dashboard rows containing `&`, HTML tags, empty failure fields, and both status values.
- Exercise every HTMX/fetch control and verify method, query parameters, and displayed acknowledgement.

## Legacy-edge decisions exposed by this inventory

The migration specification must explicitly preserve or exempt each category; implementation work must not decide them ad hoc:

1. Play-specific boolean binding, error bodies, headers, wrong-method behavior, and range semantics.
2. `reverse` changing segment order only; RSS enclosure length using duration; hard-coded `audio/mpeg`; and byte-level versus semantic XML parity.
3. Silent first-page/pagination failures, sticky failed status, all-replay/empty-page crashes, and the extra page request.
4. Image archival while audio archival is disabled; unconditional local image URL rewriting; blacklist URL refresh; media-segment statistics; and nontransactional archive scheduling.
5. Direct compatibility with the current SQLite schema versus a deterministic export/import contract.
6. FFmpeg/HLS archival behavior versus the strict Cloudflare-only/free-tier constraints.
