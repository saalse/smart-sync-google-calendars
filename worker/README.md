# iCloud busy-time feed (Cloudflare Worker)

A read-only Worker that logs in to iCloud CalDAV and returns **busy intervals only** (no titles, places or
attendees) for your calendars. The Apps Script side (`scripts/ICloudSource.gs`) calls it; MirrorBusy
then writes plain `Busy` events into the proxy calendar.

Apps Script can't send the `PROPFIND` and `REPORT` requests that CalDAV needs, so this Worker sits in between.
Full design: [`docs/icloud-spec.md`](../docs/icloud-spec.md). Owner setup, step by step:
[`docs/icloud-setup.md`](../docs/icloud-setup.md).

## API

Every request: `GET` with `Authorization: Bearer <FEED_TOKEN>`. Calendars are display names, repeated:
`calendars=Calendar%20A&calendars=Calendar%20B` (1 to 10), or `calendars=*` for every event calendar (400 if there
are more than 10).

| Path | Query | Returns |
|---|---|---|
| `/calendars` | none | `{ ok, calendars: [{ name }] }`: event calendars' display names, sorted, no duplicates |
| `/version` | `calendars` | `{ ok, version, calendars: [{ name, ok, error? }] }`; `version` changes whenever a selected calendar changes |
| `/busy` | `calendars`, `start`, `end` (ISO instants, ≤ 400 days), `tz` (IANA, default `UTC`) | `{ ok, version, cache, calendars: [{ name, ok, error?, count }], intervals: [{ calendar, id, start, end, allDay }] }` |

Errors: `400 bad_request`, `401 unauthorized`, `404`, `405`, `500 not_configured`, `502 upstream_auth`
(Apple ID or app-specific password rejected), `502 upstream_unavailable`. Per calendar (inside a 200):
`not_found`, `no_ctag`, `query_failed`, `parse_failed`.

## Files

| File | What it does |
|---|---|
| `src/index.js` | routing, token check, parameter validation, cache, JSON responses, safe logging |
| `src/caldav.js` | iCloud login and calendar list (tsdav), ctag version, one `calendar-query` per calendar |
| `src/expand.js` | ICS → intervals: recurrences, overrides, time zones, all-day, skip rules (ical.js) |
| `test/` | `node:test` suites, an in-memory iCloud mock and synthetic fixtures; `bench.mjs` measures CPU |

## Develop and test (no network, no real accounts)

```bash
npm install
```

```bash
npm test
```

```bash
npm run bench
```

```bash
npm run check
```

`npm run check` bundles the Worker with `wrangler deploy --dry-run` and uploads nothing.

Local run against your real iCloud account (optional): copy `.dev.vars.example` to `.dev.vars` (gitignored), fill
it in, then `npx wrangler dev`.

## Deploy and secrets

**Without a terminal:** the Deploy to Cloudflare button in the main README copies this folder into your GitHub,
builds it with Workers Builds and asks for the three secrets (names from `.dev.vars.example`, help text from
`cloudflare.bindings` in `package.json`). `packageManager` pins npm so that Workers Builds' `npm ci` accepts the
lockfile. If the repository is already yours (owner or fork), import it in Workers Builds with root path `worker`
instead, and add the secrets under Settings → Variables & Secrets. Step by step: [`docs/icloud-setup.md`](../docs/icloud-setup.md).

**With wrangler:**

```bash
npx wrangler login
```

```bash
npx wrangler deploy
```

Then set the three secrets. Each command prompts for the value, so nothing lands in shell history, and each one
publishes a new version:

```bash
npx wrangler secret put ICLOUD_APPLE_ID
```

```bash
npx wrangler secret put ICLOUD_APP_PASSWORD
```

```bash
npx wrangler secret put FEED_TOKEN
```

| Secret | Value |
|---|---|
| `ICLOUD_APPLE_ID` | your Apple ID (email) |
| `ICLOUD_APP_PASSWORD` | an app-specific password made only for this Worker (account.apple.com → Sign-In and Security) |
| `FEED_TOKEN` | the `ICLOUD_FEED_TOKEN` Script Property that `setupICloud` creates (or your own random token, put into that property) |

Until all three exist, the Worker answers `500 not_configured`.

## Plan and CPU

The Workers **Free plan allows 10 ms of CPU per HTTP request**. Time spent waiting on iCloud doesn't count, and
loading the script (startup) has its own 1 s limit. An isolate also tolerates infrequent overruns; only a Worker
that hits the limit consistently gets cut off (Cloudflare's limits docs). Apps Script asks only for today and the
next `ICLOUD_DAYS_AHEAD` days (default 30), and iCloud returns only the events in that range.

`npm run bench -- [days]` (or `npm run bench -- version`) replays a synthetic calendar (about one event a day, two
daily series running for years, two weekly series with moves and exclusions) through the real handler. "First
call" is the first request served by freshly loaded code: the benchmark warms up Node's own Request/Response,
WebCrypto and Intl first, because in workerd those are built in. Results on a recent Mac:

| Request | 1st call | 2nd | 3rd | Warm (median) |
|---|---|---|---|---|
| `/version` | ~17 ms | ~4 ms | ~3 ms | ~1.5 ms |
| `/busy`, 7 days ahead | ~45 ms | ~18 ms | ~20 ms | ~5 ms |
| `/busy`, **30 days ahead** | **~50 ms** | **~28 ms** | **~20 ms** | **~7 ms** |
| `/busy`, 60 days ahead | ~60 ms | ~45 ms | ~35 ms | ~10 ms |
| `/busy`, 366 days ahead | ~135 ms | ~80 ms | ~48 ms | ~39 ms |

The first calls on fresh code cost more because V8 compiles the library code as it goes. `/version` runs every 5
minutes and is nearly always within the limit. `/busy` runs rarely (when something changed, once a day, and on
Google-triggered syncs), so it often meets code that isn't warm yet and goes over. Whether Cloudflare treats that
as "infrequent" only shows in production: Workers & Pages → the Worker → **Metrics** → Errors → Invocation
Statuses → **Exceeded CPU Time Limits**. The per-request CPU time is also in the Workers Logs invocation log. When
nothing has changed, the ctag-keyed cache answers `/busy` without parsing anything (if the cache works on your
domain; the `cache` field in the response tells you).

A request over the limit gets Cloudflare error 1102 ("Worker exceeded resource limits"), not JSON. Apps Script
treats that as a failed read: it deletes nothing and retries later. If it happens regularly, shorten the horizon or
move the Worker (Deno Deploy's free plan lists no per-request CPU limit on its pricing page; check its limits page
first) or to Workers Paid.

## Logs

`observability.enabled` is on. Read the logs in the Cloudflare dashboard or with `npx wrangler tail`. Each
request logs one line: path, status, per-calendar counts or error codes, cache hit/miss, and `ms`. The `ms`
value is wall time spent waiting on iCloud: the Workers clock does not advance during CPU work, so CPU time is
not in it. The logs never contain the token, the Apple ID or password, calendar names, event text, UIDs or
times.

## Author

[Alex Samson](https://saalse.com). Part of [Busy Calendars](https://github.com/saalse/busy-calendars).
