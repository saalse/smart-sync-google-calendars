# iCloud busy-time feed (Cloudflare Worker)

A read-only Worker that logs in to iCloud CalDAV and returns **busy intervals only** (no titles, places or
attendees) for the calendars you name. The Apps Script side (`scripts/ICloudSource.gs`) calls it; MirrorBusy
then writes plain `Busy` events into the proxy calendar.

Apps Script can't send the `PROPFIND` and `REPORT` requests that CalDAV needs, so this Worker sits in between.
Full design: [`docs/icloud-spec.md`](../docs/icloud-spec.md). Owner setup, step by step:
[`docs/icloud-setup.md`](../docs/icloud-setup.md).

## API

Every request: `GET` with `Authorization: Bearer <FEED_TOKEN>`. Calendars are display names, repeated:
`calendars=Calendar%20A&calendars=Calendar%20B` (1 to 10).

| Path | Query | Returns |
|---|---|---|
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
| `FEED_TOKEN` | a random token, e.g. `openssl rand -base64 32`; the same value goes into the Script Property `ICLOUD_FEED_TOKEN` |

Until all three exist, the Worker answers `500 not_configured`.

## Plan and CPU

The Workers **Free plan allows 10 ms of CPU per request**. Apps Script asks only for today and the next
`ICLOUD_DAYS_AHEAD` days (default 30), and iCloud returns only the events in that range.

`npm run bench [days]` replays a synthetic calendar (about one event a day, two daily series running for years,
two weekly series with moves and exclusions) through the real handler. Results on a recent Mac:

| Days ahead | Warm (median) | Cold (fresh process) |
|---|---|---|
| 7 | ~5 ms | ~95 ms |
| 30 | ~7–8 ms | ~100 ms |
| 60 | ~10–12 ms | ~115 ms |
| 366 | ~38 ms | ~190 ms |

A warm Worker fits in Free at 30 days. A freshly started one does not: most of the cold time is one-off
compilation of the library code, whatever the window. `/version` is ~2 ms warm and ~45 ms cold. How often
Cloudflare starts a fresh Worker for a request every 5 minutes only shows in production: check CPU time in the
dashboard (Workers & Pages → the Worker → Metrics). When nothing has changed, the ctag-keyed cache answers
`/busy` without parsing anything (if the cache works on your domain; the `cache` field in the response tells you).

If a request goes over the limit, Cloudflare returns an error page. Apps Script treats that as a failed read: it
deletes nothing and retries later. If that happens often, use a shorter horizon or **Workers Paid**; the code is
the same.

## Logs

`observability.enabled` is on. Read the logs in the Cloudflare dashboard or with `npx wrangler tail`. Each
request logs one line: path, status, per-calendar counts or error codes, cache hit/miss, and `ms`. The `ms`
value is wall time spent waiting on iCloud: the Workers clock does not advance during CPU work, so CPU time is
not in it. The logs never contain the token, the Apple ID or password, calendar names, event text, UIDs or
times.
