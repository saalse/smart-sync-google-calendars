---
title: "iCloud busy time: specification"
sidebarTitle: iCloud design
description: "Design of the iCloud busy-time feed: Worker API, recurrence, safety rules and limits."
---

Status: built (`worker/`, `scripts/ICloudSource.gs`). Setup steps: [iCloud setup](https://saalse-busy-calendars.docs7.io/icloud-setup).
Author: [Alex Samson](https://saalse.com).

## 1. Goal and rules

Show busy time from iCloud calendars in the **proxy** Google account's **primary** calendar as plain `Busy` events,
so booking tools that read only that calendar see iCloud commitments.

- **MirrorBusy** (`scripts/MirrorBusy.gs`, setup: [`proxy-setup.md`](https://saalse-busy-calendars.docs7.io/proxy-setup)) writes the proxy events.
  This spec covers reading iCloud and handing MirrorBusy busy intervals.
  iCloud does not go into Busy Time.
- An iCloud change reaches the proxy within about 5 minutes. A full sync runs at least once a day.
- **A failed or partial iCloud read never deletes proxy events.**
- No event text (titles, places, people) leaves the Worker.
- Setup needs only a browser (Deploy to Cloudflare button + `setupICloud`).

Out of scope: booking-service integrations, writing to iCloud, changing calendar sharing or settings.

## 2. Architecture

```
iCloud CalDAV ──PROPFIND/REPORT──▶ Cloudflare Worker ──GET + Bearer──▶ Apps Script (ICloudSource.gs) ──▶ MirrorBusy ──▶ proxy "Busy"
```

Apps Script's `UrlFetchApp` can't send `PROPFIND`/`REPORT`, so a Worker sits in between. It has no storage or
schedule; it runs only when Apps Script calls it.

## 3. Worker API

- `GET` only (else `405`). Every request needs `Authorization: Bearer <FEED_TOKEN>` (else `401`, no detail). The
  token is compared in constant time (SHA-256 of both, then `timingSafeEqual`).
- `calendars`: repeated display names, matched exactly, 1–10; or `*` for every event calendar (`400` if more than
  10). Several calendars sharing a name are read together.
- JSON, `Cache-Control: no-store`, no CORS.

| Path | Query | Returns |
|---|---|---|
| `/calendars` | none | `{ ok, calendars: [{ name }] }`, sorted, no duplicates, VTODO-only lists left out |
| `/version` | `calendars` | `{ ok, version, calendars: [{ name, ok, error? }] }` |
| `/busy` | `calendars`, `start`, `end` (ISO instants, ≤ 400 days), `tz` (IANA, default `UTC`) | `{ ok, version, cache, calendars: [{ name, ok, error?, count }], intervals: [{ calendar, id, start, end, allDay }] }` |

- `version` = SHA-256 of `name\0ctags\n` lines sorted by name; `null` if any calendar is missing or has no ctag.
  `/busy` computes it from ctags read before the event query, so a change during the request only causes an
  extra sync later.
- `ok` is true only if every calendar is ok. Intervals from ok calendars come back even when another failed.
- `id` = `UID|<occurrence id>`: the RECURRENCE-ID in UTC (`YYYYMMDDTHHMMSSZ`), `YYYYMMDD` for all-day series, `-`
  for single events. A moved occurrence keeps its id.
- Timed: UTC instants with `Z`. All-day: `YYYY-MM-DD`, `end` exclusive.

Errors: `400 bad_request` (with `message`), `401 unauthorized`, `404`, `405`, `500 not_configured` (a secret is
missing), `502 upstream_auth` (Apple rejected the sign-in), `502 upstream_unavailable`. Per calendar, inside a
`200`: `not_found`, `no_ctag`, `query_failed`, `parse_failed` (one bad object fails the whole calendar).

## 4. CalDAV

tsdav 2.5.0 (native `fetch`, XML via xml-js; Workers have no `DOMParser`), Basic auth with Apple ID +
app-specific password against `https://caldav.icloud.com`.

1. Discovery: principal, then calendar home (~3 requests plus iCloud's redirect to the account's host).
2. One `PROPFIND Depth: 1` on the home lists calendars with `displayname`, `getctag` and component set. Lists
   without `VEVENT` are ignored. `/calendars` and `/version` stop here.
3. `/busy`: one `REPORT calendar-query` per calendar, `VEVENT` time-range filter, widened by a day on each side.
   No `<C:expand>`: the Worker always expands recurrences itself.

About 4 + one subrequest per calendar, well under the Free plan's 50.

## 5. Recurrence, time zones, all-day

ical.js 2.2.1, per calendar object:

- Master and overrides are grouped by UID. An override without a master is a standalone event.
- Series are iterated with ical.js (RDATE, EXDATE, THISANDFUTURE via `getOccurrenceDetails`). DTSTART is added
  explicitly for RDATE-only series (ical.js skips it). Overridden instances are taken from their override, which
  is checked against the window by its own times. Cap: 20,000 iterations per series → `parse_failed`, never
  silent truncation.
- Skipped: `TRANSP:TRANSPARENT`, `STATUS:CANCELLED`, declined by the Apple ID, zero or negative length.
- End: DTEND, else DTSTART + DURATION, else one day for a DATE start.
- Zones: `Z` = UTC; TZID uses the object's VTIMEZONE, else the IANA name via `Intl` (unknown → `parse_failed`);
  floating times use `tz`. Repeated local times take the first occurrence, skipped ones the offset before the
  jump (RFC 5545 §3.3.5).
- All-day intervals are tested against the window as dates in `tz`. The window is half-open.

CPU work for the Free plan's 10 ms: identical VTIMEZONEs are hydrated once and shared; a fast `utcOffset` replaces
ical.js's slow one; simple DAILY/WEEKLY series skip ahead to the window; nothing before the window is looked at
in detail. Tests prove each shortcut gives the same output as plain ical.js.

## 6. Cache and change detection

- **Worker cache** (optional, best effort): key `<origin>/__cache/busy/<sha256(version, start, end, tz, calendars)>`,
  1 hour, only for fully ok responses. Any iCloud change gives a new ctag and so a new key. The docs disagree on
  whether the cache works on `workers.dev`; the `cache` field shows it.
- **Apps Script**: `checkICloudAndSync` compares `/version` with `ICLOUD_LAST_VERSION`, which only a fully
  successful `/busy` read writes. A skipped sync or failed read leaves the old value, so the next check retries.
  The version is saved before MirrorBusy writes; if that write fails, the next change or the daily sync retries.

## 7. Apps Script (`scripts/ICloudSource.gs`)

**`setupICloud()`**, run by hand, any number of times. It never writes calendars.

1. Creates `ICLOUD_FEED_TOKEN` (64 hex from two `Utilities.getUuid()`) if missing. Never logs it.
2. Stops with the next step if `ICLOUD_FEED_URL` is empty.
3. Calls `/calendars`, prints the names, explains common errors (token, missing secret, Apple sign-in, wrong URL).
4. Stops if a configured name is missing, or if "all" means more than 10.
5. Runs `debugICloud(ICLOUD_DAYS_AHEAD)`: every busy interval within the horizon.
6. Only if `fetchICloudBusyIntervals` is in `MIRROR_EXTRA_PROVIDERS`: replaces any `checkICloudAndSync` trigger
   with one every 5 minutes.

**`fetchICloudBusyIntervals(start, end, {dryRun})`**: the MirrorBusy provider. It never throws.

- Clips the window to the horizon `[yesterday 00:00 UTC, + ICLOUD_DAYS_AHEAD + 2 days)` (default 30) and returns
  it as `coverage`. A window entirely outside → `ok: false`.
- `ok` only if HTTP 200, valid JSON, feed `ok`, every configured calendar present and ok (with "all": every calendar
  the feed lists), and every interval valid. Otherwise `ok: false` with the valid intervals still returned.
- Maps to `{ key: "<calendar>|<id>", start: {dateTime}|{date}, end: …, allDay }`.
- Writes `ICLOUD_LAST_VERSION` + `ICLOUD_LAST_OK_AT`, or `ICLOUD_LAST_FAILURE_AT` (not in dry run).
- Logs one line: `iCloud: ok | FAILED (reason); Calendar A: 12, …`. No keys, UIDs or times.

**`checkICloudAndSync()`**, every 5 minutes:

```
not configured, or provider not in MIRROR_EXTRA_PROVIDERS → warn, return
24 h since last sync or last ok read   → sync ("daily")
failed read < 15 min ago               → back off
/version differs from the saved one    → sync ("changed")
afterwards: no ok read for > 24 h and failing → throw (Google emails the owner)
```

The sync itself is `SyncCalendarsIntoOne()`, which takes the script lock. The back-off keeps a broken `/busy` from
running a full sync every 5 minutes. The thrown error matters because while iCloud fails MirrorBusy deletes
nothing at all.

**`debugICloud(days = 7)`**: prints state, `/version` per calendar and every interval in the script's zone.
Writes nothing.

## 8. Configuration and secrets

| Where | Name | Meaning |
|---|---|---|
| `Config.gs` | `ICLOUD_FEED_URL` | Worker URL, no token; empty = iCloud off |
| `Config.gs` | `ICLOUD_CALENDARS` | display names, up to 10; empty = all |
| `Config.gs` | `ICLOUD_FLOATING_TIMEZONE` | IANA zone for floating times |
| `Config.gs` | `ICLOUD_DAYS_AHEAD` | 1–366, default 30 |
| `Config.gs` | `MIRROR_EXTRA_PROVIDERS` | add `"fetchICloudBusyIntervals"` to turn iCloud on in the proxy |
| Script Property | `ICLOUD_FEED_TOKEN` | created by `setupICloud`; equals the Worker's `FEED_TOKEN` |
| Script Property | `ICLOUD_FEED_URL` | older setups only; `Config.gs` wins |
| Script Property | `ICLOUD_LAST_VERSION`, `_OK_AT`, `_FAILURE_AT`, `_RUN_AT` | state, written by the code |
| Worker secret | `ICLOUD_APPLE_ID`, `ICLOUD_APP_PASSWORD`, `FEED_TOKEN` | asked for by the Deploy button |

- The secrets are not under `secrets.required` in `wrangler.jsonc`: that makes the first `wrangler deploy` demand a
  secrets file.
- `CALDAV_SERVER_URL` is a var for tests only.
- The app-specific password is not limited to calendars (Apple also allows mail and contacts), so it lives only in
  the Worker.
- Anyone with `FEED_TOKEN` can read busy times (no text). To rotate, set the Worker secret first, then the Script
  Property; reads fail in between, so nothing gets deleted.
- Never add the proxy's own calendar to `CALENDARS_TO_MERGE` (loop).

**Deploy button:** it copies the self-contained `worker/` folder into the user's GitHub, builds with Workers
Builds (`npx wrangler deploy`), and asks for the secrets named in `.dev.vars.example`, with help text from
`cloudflare.bindings` in `package.json`. `packageManager` pins npm so `npm ci` accepts the lockfile. The source repo
must be public, and the button reads `main`. The user's copy doesn't get fixes on its own. After signing in,
Cloudflare may drop the button's repository and show the generic import page; the guide says to reopen the link.
Owners and forks skip the copy: Workers Builds imports their repository with root path `worker` (Worker name must
match `wrangler.jsonc`), and the three secrets are added under Settings → Variables & Secrets. `worker/package-lock.json`
is committed (the root `.gitignore` excludes other lockfiles) so builds use `npm ci`.

## 9. Contract with MirrorBusy

- Registration: `MIRROR_EXTRA_PROVIDERS = ["fetchICloudBusyIntervals"]`. Called as `fn(startTime, endTime)`.
- Returns `{ ok, intervals: [{ key, start, end, allDay }], coverage: { start, end } | null }`, plus `reason`,
  `calendars`, `cache`, `version` for logs.
- MirrorBusy's side:
  - store only `HMAC-SHA256(secret, provider + ":" + key)`;
  - title `Busy`, private, no reminders;
  - a missing or throwing provider counts as `ok: false`;
  - while any provider is `ok: false`, skip **all** deletions (creates and updates go on).
- MirrorBusy should delete a provider's events only within its `coverage` and its own keys. Ignoring `coverage` is
  also safe: only past iCloud events would go.
- Compare times as instants, not strings: Google may return the same instant with an offset.

## 10. Failure handling

| Failure | Worker | Apps Script | Proxy |
|---|---|---|---|
| wrong token | 401 | `ok: false` | nothing deleted |
| Apple sign-in rejected | 502 `upstream_auth` | `ok: false` | nothing deleted |
| iCloud down or slow | 502 / timeout | `ok: false` | nothing deleted |
| calendar renamed or removed | `not_found` | `ok: false` | nothing deleted |
| unparseable object | `parse_failed` | `ok: false` | nothing deleted; other calendars still create/update |
| CPU limit exceeded | Cloudflare error page | not JSON → `ok: false` | nothing deleted |
| failing > 24 h | — | `checkICloudAndSync` throws → email | nothing deleted |

The Worker logs path, status, per-calendar counts or error codes, cache state and `ms` (wall time waiting on
iCloud). It never logs the token, credentials, calendar names, event text, UIDs or times.

## 11. Limits

- **Workers Free:** 10 ms CPU per request; network waits don't count; startup has its own 1 s; infrequent overruns
  are tolerated per isolate; over → error 1102. Benchmark (`worker/README.md`): `/version` ~1.5 ms warm, `/busy` at
  30 days ~7 ms warm, ~50 ms on the first call to fresh code. `/busy` is rare, so the dashboard's "Exceeded CPU
  Time Limits" must be checked after a day. Fallbacks: a shorter horizon, Workers Paid.
- **Apps Script (consumer):**
  - triggers: 90 min/day in total; 288 checks/day at ~1–2 s plus syncs fit;
  - URL Fetch: 20,000 calls/day;
  - Properties: 50,000 reads and writes/day;
  - one execution: 6 min at most;
  - `everyMinutes`: only 1, 5, 10, 15 or 30;
  - creating a trigger from code needs the `script.scriptapp` scope;
  - a standalone project can't show menus or dialogs, so setup is a function run from the editor.
- Verified in context7 and the official docs; one exception: that iCloud ignores `<C:expand>` comes from community
  reports only, and the design doesn't depend on it.

## 12. Tests

`npm test` at the repo root, with no network and synthetic data only:

- **`worker/test`** (58 tests). Expansion cases: DST, all-day, DURATION, RRULE/RDATE/EXDATE, COUNT/UNTIL, moved
  and cancelled overrides, THISANDFUTURE, floating, unknown TZID, declined, window edges, the iteration cap,
  shortcut equivalence. HTTP: auth, errors, cache, `/calendars`, `*`, no secrets in logs. CalDAV runs against an
  in-memory iCloud mock.
- **`tests/apps-script/icloud-source.test.js`** (41 tests). Provider mapping and failures, horizon, "all" mode, the
  check decision table, `setupICloud` paths, `node --check` on every `.gs`. MirrorBusy's own tests, including one
  with the real `ICloudSource.gs`, are in `mirror-busy.test.js`.

`npm run bench` and `npm run check` (wrangler dry run) live in `worker/`.
