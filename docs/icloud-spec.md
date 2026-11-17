# iCloud busy time → proxy calendar: specification

Status: approved by the owner; phase 2 built (code in `worker/` and `scripts/ICloudSource.gs`). §17 lists what
changed during the build; §18 the browser-only setup, which supersedes the setup details in §3, §8 and §15 where
they differ.

## 1. Goal and scope

Bring busy time from selected iCloud calendars into the **proxy** Google account's **primary** calendar as plain
`Busy` events with no details. Booking tools that read only that primary calendar then see the owner's iCloud
commitments.

- iCloud does **not** go into Busy Time. Busy Time and its existing readers are unchanged.
- The proxy events are written by **MirrorBusy** (a separate feature, `scripts/MirrorBusy.gs`). This spec covers
  the part that reads iCloud and hands MirrorBusy a list of busy intervals.
- Calendars are chosen by display name in `Config.gs`. No prefixes.
- Freshness: an iCloud change reaches the proxy within about 5 minutes. A full sync runs at least once a day.
- Safety rule above all others: **a failed or partial iCloud read never deletes existing proxy events.**

Out of scope: any booking-service integration, writing to iCloud, sharing or settings changes on any calendar.

## 2. Architecture

```
iCloud CalDAV  ──PROPFIND/REPORT──▶  Cloudflare Worker (worker/)  ──GET + Bearer──▶  Apps Script
(Apple ID +                          • discovers calendars            (scripts/ICloudSource.gs)
 app-specific password)              • expands recurrences            • fetchICloudBusyIntervals()
                                     • returns intervals only         • checkICloudAndSync() every 5 min
                                                                              │
                                                                              ▼
                                                                    MirrorBusy (provider hook)
                                                                              │
                                                                              ▼
                                                                 proxy account PRIMARY: "Busy"
```

Why a Worker: Apps Script `UrlFetchApp` supports only `get`, `delete`, `patch`, `post`, `put` (confirmed in
context7, see §13), and CalDAV needs `PROPFIND` and `REPORT`. A Worker's `fetch()` supports every method except
`CONNECT` (confirmed in context7).

The Worker has no storage and no schedule of its own. It runs only when Apps Script calls it.

## 3. Worker API contract

Base URL: the Worker's address (a `workers.dev` subdomain or a custom domain). It lives only in the Script Property
`ICLOUD_FEED_URL`, never in the repo.

### 3.1 Common rules

- Only `GET`. Other methods → `405`.
- Every request needs `Authorization: Bearer <FEED_TOKEN>`. Missing or wrong → `401` with no detail.
  The token is compared in constant time: SHA-256 of both values, then `crypto.subtle.timingSafeEqual`
  (Cloudflare's documented pattern; never return early on a length mismatch).
- Calendars are passed as repeated query parameters: `calendars=<display name>&calendars=<display name>`,
  URL-encoded (names may contain `+` or spaces). 1 to 10 names, matched exactly (case-sensitive, trimmed) against
  the CalDAV `displayname`.
- Responses are `application/json; charset=utf-8` with `Cache-Control: no-store`. No CORS headers.
- The response never contains titles, descriptions, locations, attendees or other event text.

### 3.2 `GET /version`

Cheap change check. Query: `calendars` (required).

```json
{
  "ok": true,
  "version": "9f2c…(64 hex chars)",
  "calendars": [ { "name": "Calendar A", "ok": true }, { "name": "Calendar B", "ok": true } ]
}
```

- `version` = SHA-256 (hex) of the requested calendars' `getctag` values, sorted by name, joined as
  `name\u0000ctag\n`. Stable for the same state, independent of parameter order.
- If any requested calendar is missing or has no ctag: `ok: false`, `version: null`, and that calendar gets
  `{ "ok": false, "error": "not_found" | "no_ctag" }`.

### 3.3 `GET /busy`

Query: `calendars` (required), `start` and `end` (required, ISO 8601 instants, `end > start`, window ≤ 400 days),
`tz` (optional IANA zone for floating times, default `UTC`).

```json
{
  "ok": true,
  "version": "9f2c…",
  "cache": "hit | miss | off",
  "calendars": [
    { "name": "Calendar A", "ok": true, "count": 2 },
    { "name": "Calendar B", "ok": false, "error": "query_failed", "count": 0 }
  ],
  "intervals": [
    { "calendar": "Calendar A", "id": "<UID>|20261117T090000Z", "start": "2026-11-17T09:00:00Z", "end": "2026-11-17T10:00:00Z", "allDay": false },
    { "calendar": "Calendar A", "id": "<UID>|-", "start": "2026-11-20", "end": "2026-11-22", "allDay": true }
  ]
}
```

- Top-level `ok` is `true` only if every requested calendar is `ok`.
- Intervals from calendars that are `ok` are returned even when another calendar failed (creating from a partial
  list is safe; deleting is not, see §9).
- `id` = `UID` + `|` + occurrence id. The occurrence id is the `RECURRENCE-ID` of the occurrence in UTC basic
  format (`YYYYMMDDTHHMMSSZ`), or `YYYYMMDD` for all-day series, or `-` for a non-recurring event. It stays the same
  when a single occurrence is moved, so a move is an update, not delete + create.
- Timed intervals: UTC instants with `Z`. All-day intervals: `YYYY-MM-DD` dates, `end` exclusive.
- `version` is computed from ctags read **before** the event query in the same request. If iCloud changes during
  the request, the next `/version` check sees a newer ctag and syncs again (the safe direction).

### 3.4 Errors

| HTTP | `error` | When |
|---|---|---|
| 400 | `bad_request` | missing/invalid parameter, window > 400 days, more than 10 calendars |
| 401 | `unauthorized` | missing or wrong token (body has no other detail) |
| 404 / 405 | `not_found` / `method_not_allowed` | unknown path / not GET |
| 500 | `not_configured` | a Worker secret is missing |
| 502 | `upstream_auth` | iCloud rejected the Apple ID or app-specific password |
| 502 | `upstream_unavailable` | iCloud discovery failed (network, 5xx, malformed XML) |

Per-calendar errors (inside a `200`): `not_found`, `no_ctag`, `query_failed`, `parse_failed`. A calendar where any
single object fails to parse is `parse_failed` as a whole: its list would be incomplete.

## 4. CalDAV discovery and queries

Library: **tsdav** (pin an exact version; 2.5.0 at the time of writing). context7 confirms it supports Cloudflare
Workers and uses the runtime's native `fetch`; its iCloud example is exactly Apple ID + app-specific password with
`authMethod: 'Basic'` against `https://caldav.icloud.com`. It parses XML with `xml-js` (pure JS), which matters
because Workers have no `DOMParser`.

Per request (all network waits; none of this counts as Worker CPU time):

1. **Login / discovery** (`createDAVClient`, `defaultAccountType: 'caldav'`): service discovery, then
   `DAV:current-user-principal` (RFC 5397), then `CALDAV:calendar-home-set` (RFC 4791 §6.2.1). About 3 requests,
   plus any redirect iCloud issues to its per-account host.
2. **List calendars**: one `PROPFIND Depth: 1` on the calendar home with tsdav's `propfind` (not `fetchCalendars`,
   which adds a `supported-report-set` PROPFIND for every calendar in the account). Calendars whose
   `supported-calendar-component-set` excludes `VEVENT` (Reminders lists) are ignored. Each `DAVCalendar` carries
   `displayName`, `url` and `ctag` (`{http://calendarserver.org/ns/}getctag`, which changes whenever a resource in
   the calendar is added, changed or deleted — official calendarserver extension doc). `/version` stops here.
3. **Query events** (`/busy` only), one `REPORT calendar-query` per selected calendar, `Depth: 1`, asking for
   `getetag` + `calendar-data`, with filter `VCALENDAR > VEVENT > time-range(start, end)` in UTC basic format.
   Use tsdav `calendarQuery` (single round trip) rather than the default query + multiget.
   **No `<C:expand>`.** iCloud is reported to ignore it (community reports; python-caldav lists iCloud recurrence
   support as broken — not confirmed by an official Apple doc). The Worker always expands recurrences itself, so the
   design works whether or not the server expands.
   Per RFC 4791 §9.9 a recurring event matches when any instance overlaps the range, and the whole calendar object
   (master plus overridden instances) comes back. The Worker still filters every occurrence against the window.

Subrequests per `/busy`: about 4 + one per calendar (≈ 7 for 3 calendars), well under the Free plan's 50.

## 5. Recurrence, time zones, all-day

Library: **ical.js** (pin an exact version; 2.2.1 at the time of writing; ES module, no dependencies). Confirmed in
context7: `ICAL.Event` with `relateException()`, `event.iterator()` (a `RecurExpansion` that applies RDATE and
EXDATE), and `getOccurrenceDetails()` which returns the real start/end for direct exceptions and for
`RANGE=THISANDFUTURE` exceptions. No separate rrule library is needed.

Per calendar object:

1. Parse with `ICAL.parse` → `ICAL.Component`. Group `VEVENT`s by `UID`: the master (no `RECURRENCE-ID`) and its
   overrides. Relate overrides to the master. An override without a master in the same object (an invitation to
   one instance) is treated as a standalone event.
2. **Non-recurring:** one interval from DTSTART/DTEND.
3. **Recurring:** iterate from the series start (ical.js cannot start mid-series: COUNT and some BY rules need
   every occurrence counted). For each occurrence before the window end:
   - if it has a direct override, skip it here (overrides are handled in step 4);
   - otherwise take `getOccurrenceDetails()` start/end and keep it if it overlaps the window.
   Hard cap: 20,000 iterations per series. Hitting the cap marks the calendar `parse_failed` (never a silent
   truncation).
4. **Overrides:** each override is checked against the window by its own start/end, so an occurrence moved into
   the window from outside it is caught, and one moved out is dropped.
5. **Skip rules** (applied per occurrence, so they work on overrides too):
   - `TRANSP:TRANSPARENT` (marked free);
   - `STATUS:CANCELLED`;
   - an `ATTENDEE` whose address equals the Apple ID with `PARTSTAT=DECLINED` (best effort; tentative and
     needs-action count as busy);
   - zero or negative duration.
6. **End time:** DTEND; else DTSTART + DURATION; else, for a DATE start, one day (RFC 5545 §3.6.1); a DATE-TIME start
   with neither is zero-length and skipped.
7. **Time zones:**
   - `…Z` values are UTC.
   - `TZID` values use the `VTIMEZONE` inside the same object; context7 confirms ical.js resolves a TZID from the
     component tree first. If the object has no matching `VTIMEZONE`, the TZID is treated as an IANA name and
     converted with `Intl.DateTimeFormat` (Workers support `Intl`; the runtime clock is UTC). Unknown TZID →
     `parse_failed`.
   - Floating times (no `Z`, no `TZID`) are read in the `tz` parameter.
   - DST: occurrences are generated in the event's own zone, then converted to UTC, so a 09:00 series stays 09:00
     local across DST changes.
8. **All-day:** a DATE DTSTART gives `allDay: true` with dates, not instants. Window test for all-day intervals uses
   the window converted to dates in `tz`.
9. **Window test:** keep when `start < windowEnd` and `end > windowStart` (half-open; an event ending exactly at the
   window start is out).

## 6. Cache and version check

### 6.1 Worker cache (best effort, never needed for correctness)

`/busy` is called on every sync, including syncs started by Google calendar triggers, so it should be cheap when
nothing changed. After discovery (step 2 in §4) the Worker has the current ctags, so:

- cache key = GET URL on the Worker's own origin, `<origin>/__cache/busy/<sha256(version, start, end, tz, sorted
  calendars)>` (Cloudflare's documented pattern; the path is never served because every request runs the Worker,
  which answers 401/404 for it); it contains no token and no calendar names;
- hit → return the stored JSON with `"cache": "hit"`; miss → query, expand, store with
  `Cache-Control: max-age=3600`, return `"cache": "miss"`;
- any iCloud change produces a new ctag, so a new key: a stale result can't be served;
- only fully `ok` responses are cached.

context7 confirms `caches.default.put()` requires a GET request as the key and that `cache.match()` never calls the
origin. The docs are **inconsistent** about `workers.dev`: one page says functional cache operations need a custom
domain, another says the Worker's cache is shared across all ingress paths including `workers.dev`. So the cache is
an optimization only; the `cache` field shows the owner whether it works on the chosen domain.

### 6.2 Version check in Apps Script

`checkICloudAndSync()` runs every 5 minutes (§7.2). It calls `/version` and runs the full sync only when the version
differs from `ICLOUD_LAST_VERSION`. `ICLOUD_LAST_VERSION` is written **only** by `fetchICloudBusyIntervals()` after
a fully successful `/busy` read, using the `version` from that same response. Consequences:

- a sync that was skipped (lock busy) or an iCloud read that failed leaves the old value, so the next check retries;
- a sync started by a Google calendar trigger also refreshes the version, so the 5-minute check skips a duplicate run.

Known limitation: the version is saved when the iCloud read succeeds, before MirrorBusy writes the proxy. If the
proxy write then fails, the retry comes from the next iCloud change or the daily full sync (≤ 24 h).

## 7. Apps Script side (`scripts/ICloudSource.gs`)

### 7.1 `fetchICloudBusyIntervals(startTime, endTime, options)`

MirrorBusy provider. `startTime`/`endTime` are `Date`s; `options` is optional (`{ dryRun: true }` from the debug
helper only).

1. Read `ICLOUD_CALENDARS` (Config) and `ICLOUD_FEED_URL`, `ICLOUD_FEED_TOKEN` (Script Properties). Anything missing
   → log an error, return `{ ok: false, intervals: [] }`.
2. **Horizon** (added in phase 2, §17): the requested window is clipped to `[yesterday 00:00 UTC, that +
   ICLOUD_DAYS_AHEAD + 2 days)` (default 30 days). The past and the far future don't matter for booking, and a
   short window keeps the Worker near the Free plan's CPU limit. Whole UTC days keep the Worker's cache key stable
   for a day. The clipped range is returned as `coverage`. A window entirely outside the horizon → `ok: false`.
3. `UrlFetchApp.fetch(url + '/busy?…', { method: 'get', headers: { Authorization: 'Bearer ' + token },
   muteHttpExceptions: true, timeoutSeconds: 60 })`. Query: `start`/`end` = the clipped range, each calendar as a
   `calendars` parameter, `tz` = `ICLOUD_FLOATING_TIMEZONE`.
4. Result is `ok: true` only if: HTTP 200, valid JSON, top-level `ok: true`, every configured calendar present with
   `ok: true`, and every interval valid (`end > start`, parseable, `allDay` matches the format). Otherwise
   `ok: false` and the valid intervals from `ok` calendars are still returned (creates are safe; MirrorBusy skips
   deletions).
5. Map each interval to the MirrorBusy shape:
   - `key` = `<calendar display name>|<id>` (readable, e.g. `Calendar A|<UID>|20261117T090000Z`). Not hashed here:
     MirrorBusy HMACs it.
   - timed → `start: { dateTime: '<UTC ISO>' }`, `end: { dateTime: '<UTC ISO>' }` (context7: Calendar API accepts
     `dateTime` from `toISOString()` without `timeZone`);
   - all-day → `start: { date: 'YYYY-MM-DD' }`, `end: { date: 'YYYY-MM-DD' }`.
6. Unless `dryRun`: on `ok` write `ICLOUD_LAST_VERSION` and `ICLOUD_LAST_OK_AT`; on failure write
   `ICLOUD_LAST_FAILURE_AT`.
7. Log one summary line every run: `iCloud: ok | FAILED (reason); Calendar A: 12, Calendar B: failed (query_failed)`.
   Calendar names appear only in this owner-only log. No keys, UIDs or times in routine logs.

It never throws to MirrorBusy: all errors become `ok: false` (MirrorBusy also treats a throw as `ok: false`).

### 7.2 `checkICloudAndSync()` (5-minute time-driven trigger)

Takes no lock itself; `SyncCalendarsIntoOne()` takes the script lock (LockService docs don't promise re-entrancy).

```
if not configured → warn, return
if "fetchICloudBusyIntervals" not in MIRROR_EXTRA_PROVIDERS → warn, return
lastRun = max(ICLOUD_LAST_RUN_AT, ICLOUD_LAST_OK_AT)
if now - lastRun ≥ 24 h            → reason "daily"
else if ICLOUD_LAST_FAILURE_AT < 15 min ago → log "backing off", skip to health check
else GET /version (timeoutSeconds 30)
     failure                       → log, skip to health check
     version == ICLOUD_LAST_VERSION → log "no change", skip to health check
     else                          → reason "changed"
if reason: ICLOUD_LAST_RUN_AT = now; SyncCalendarsIntoOne()
health check: if ICLOUD_LAST_FAILURE_AT > ICLOUD_LAST_OK_AT and (no ICLOUD_LAST_OK_AT or it is > 24 h old)
     → throw Error("iCloud has not synced for over 24 h: …")
```

- The provider check matters: without it nothing would ever write `ICLOUD_LAST_VERSION`, and every check would
  run a full sync.
- The daily rule needs no second trigger.
- The 15-minute back-off keeps a broken `/busy` (for example the Worker hitting its CPU limit) from running a full
  sync every 5 minutes and eating the trigger runtime quota.
- The thrown error is the alarm: context7 confirms that when an installable trigger's function throws, Apps Script
  emails the owner (failure notification settings: immediately or daily). This matters because while iCloud is
  failing, MirrorBusy skips **all** proxy deletions, including those from Google sources.
- Trigger created in the Apps Script UI (Time-driven → Minutes timer → Every 5 minutes), like the existing calendar
  triggers. Creating it from code would need the extra `script.scriptapp` scope in `appsscript.json`.
  `everyMinutes(n)` accepts 1, 5, 10, 15 or 30 (context7).

Quota budget (consumer account, context7): triggers total runtime 90 min/day; URL Fetch 20,000 calls/day;
Properties 50,000 reads/writes/day; 6 min per execution. 288 checks × ~1–2 s ≈ 5–10 min/day, plus one full sync
(~20–30 s) per iCloud change. Google-triggered syncs each add one `/busy` call (~1–3 s).

### 7.3 `debugICloud(days)` (run by hand)

Run from the Apps Script editor; `days` defaults to 7. Writes nothing to any calendar or property:

- prints the state properties (`ICLOUD_LAST_VERSION`, `…_OK_AT`, `…_FAILURE_AT`, `…_RUN_AT`; never the token);
- calls `/version` and prints per-calendar status;
- calls `fetchICloudBusyIntervals(now, now + days, { dryRun: true })` and prints per-calendar counts and every
  interval as `Tue 17 Nov 09:00–10:00 · Calendar A` in the script's calendar time zone, plus the cache field.

The proxy-side debug helper (`debugProxyDay`) belongs to MirrorBusy.

## 8. Configuration and secrets

### 8.1 `Config.gs` (gitignored; the example file gets placeholders)

| Key | Example | Meaning |
|---|---|---|
| `ICLOUD_FEED_URL` | `"https://icloud-busy-feed.<sub>.workers.dev"` | Worker base URL, no token (§18; empty = iCloud off) |
| `ICLOUD_CALENDARS` | `["Calendar A", "Calendar B"]` | iCloud display names to read; empty = all (§18) |
| `ICLOUD_FLOATING_TIMEZONE` | `"Europe/Berlin"` | zone for floating times |
| `ICLOUD_DAYS_AHEAD` | `30` | days ahead to read, 1–366 (phase 2) |
| `MIRROR_EXTRA_PROVIDERS` | `["fetchICloudBusyIntervals"]` | MirrorBusy's key; enables iCloud in the proxy |

Rule for docs: never add the proxy's primary calendar to `CALENDARS_TO_MERGE`, or Busy events loop back.

### 8.2 Script Properties (Project Settings → Script Properties)

| Property | Set by | Meaning |
|---|---|---|
| `ICLOUD_FEED_URL` | owner | older setups only; `Config.gs` wins (§18) |
| `ICLOUD_FEED_TOKEN` | `setupICloud` | same value as the Worker's `FEED_TOKEN` |
| `ICLOUD_LAST_VERSION` | code | version from the last fully successful read |
| `ICLOUD_LAST_OK_AT` | code | ISO time of the last fully successful read |
| `ICLOUD_LAST_FAILURE_AT` | code | ISO time of the last failed read |
| `ICLOUD_LAST_RUN_AT` | code | ISO time `checkICloudAndSync` last started a sync |

All values are far below the 9 KB per-value limit (context7).

### 8.3 Worker secrets (`npx wrangler secret put <NAME>`, encrypted, never in the repo)

| Secret | Meaning |
|---|---|
| `ICLOUD_APPLE_ID` | the main Apple ID |
| `ICLOUD_APP_PASSWORD` | an app-specific password used only by this Worker |
| `FEED_TOKEN` | random bearer token, at least 32 bytes (`openssl rand -base64 32`) |

`wrangler.jsonc` names them in a comment, not under `secrets.required`: with that field the first `wrangler deploy`
of a new Worker refuses to run unless the secrets come from a file on disk (`--secrets-file`; found in wrangler's
source during the build). For local dev they go in `.dev.vars` (gitignored); `.dev.vars.example` holds names only. No `vars` hold secrets (Cloudflare's own
caution). Optional var `CALDAV_SERVER_URL` (default `https://caldav.icloud.com`) exists only so tests can point at a
mock.

Security notes: an app-specific password is not scoped (Apple lists mail, contacts and calendars), so it lives only
in the Worker and is never logged. Turn on 2FA for the Cloudflare account. Anyone with `FEED_TOKEN` can read busy
intervals (no titles) of any calendar the Apple ID can see; rotate it by putting a new secret and updating the
Script Property (during the gap reads fail, so nothing is deleted).

## 9. Contract with MirrorBusy

Registration: `MIRROR_EXTRA_PROVIDERS = ["fetchICloudBusyIntervals"]`. MirrorBusy calls each named global function
as `fn(startTime, endTime)` with its own sync window.

Return value: `{ ok: boolean, intervals: [ { key, start, end, allDay } ], coverage: { start, end } | null }`,
where `start`/`end` are `{ dateTime }` or `{ date }`. `coverage` (ISO instants, added in phase 2) is the part of
the requested window the provider actually read; outside it the provider returns nothing. Extra fields (`reason`,
`calendars`, `cache`, `version`) are for logs and `debugICloud`.

Coverage and deletions: if MirrorBusy deletes a provider's proxy events only inside that provider's `coverage`,
nothing outside the horizon is touched. If it ignores `coverage`, iCloud Busy events that have passed get deleted
on the next run (harmless for booking), and nothing beyond the horizon exists to delete, since the horizon only
moves forward. Either is safe. Deletions must still be scoped to the provider's own keys.

What MirrorBusy guarantees (Session A's side, restated so both sides test the same thing):

- stores only `mirrorKey = HMAC-SHA256(secret, providerName + ":" + key)` in the proxy event's private extended
  properties (`Utilities.computeHmacSha256Signature(value, key)` returns `Byte[]`; context7);
- title exactly `Busy`, no other details, private, no reminders;
- a missing or throwing provider counts as `ok: false`;
- while **any** provider is `ok: false`, the run skips **all** deletions; creates and updates still happen.

Request to Session A from this spec: compare start/end as **instants** (or dates for all-day), not as strings. The
provider sends UTC `…Z` strings, and Google may return the same instant with the calendar's offset when MirrorBusy
reads the proxy back. (Known Calendar API behaviour; context7 showed the insert format but not the read-back format,
so treat it as unconfirmed and compare instants either way.)

MirrorBusy is not built yet (no `mirror-busy` branch exists). ICloudSource can be built and tested on its own; it
has effect only after MirrorBusy is merged and `MIRROR_EXTRA_PROVIDERS` is set.

## 10. Error handling (summary)

| Failure | Worker | Apps Script | Proxy |
|---|---|---|---|
| wrong token | 401 | `ok: false`, failure logged | nothing deleted |
| Apple ID / password rejected | 502 `upstream_auth` | `ok: false` | nothing deleted |
| iCloud down / slow | 502 or Apps Script timeout | `ok: false` | nothing deleted |
| calendar renamed or removed | calendar `not_found` | `ok: false`, name in log | nothing deleted |
| one object unparseable | calendar `parse_failed` | `ok: false` | nothing deleted; other calendars still create/update |
| Worker CPU limit exceeded | Cloudflare error page | non-JSON → `ok: false` | nothing deleted |
| failing > 24 h | — | `checkICloudAndSync` throws → email to owner | nothing deleted |

## 11. Debugging (only in places the owner sees)

1. **Apps Script log**, every run: one iCloud summary line (§7.1) and the decision line of `checkICloudAndSync`.
2. **`debugICloud()`** run by hand (§7.3).
3. **Calling the Worker directly** from the owner's terminal, with the token read silently so it stays out of shell
   history:
   ```bash
   read -rs FEED_TOKEN && export FEED_TOKEN
   curl -sS -H "Authorization: Bearer $FEED_TOKEN" "$WORKER_URL/version?calendars=Calendar%20A"
   curl -sS -H "Authorization: Bearer $FEED_TOKEN" "$WORKER_URL/busy?calendars=Calendar%20A&start=2026-11-17T00:00:00Z&end=2026-11-24T00:00:00Z"
   ```
4. **Worker logs**: `observability.enabled: true` in `wrangler.jsonc`; view in the Cloudflare dashboard or with
   `npx wrangler tail`. The Worker logs only path, status, per-calendar ok/error codes, counts, cache hit/miss and
   duration (`ms`; wall time spent waiting on iCloud, because the Workers clock does not advance during CPU work). Never the Authorization header, credentials, ICS text, UIDs or interval times.

## 12. Tests (phase 2; no network, no real accounts)

Worker (`worker/test/`, Node's built-in `node:test`, synthetic ICS fixtures with no real data):

- expansion: single timed with TZID across a DST change; all-day single and multi-day; DATE without DTEND (1 day);
  DURATION instead of DTEND; weekly RRULE with EXDATE; RDATE; COUNT and UNTIL; override moved into the window; moved
  out; cancelled override; transparent override; `RANGE=THISANDFUTURE`; orphan override; floating time with `tz`;
  TZID without VTIMEZONE; unknown TZID → `parse_failed`; declined; zero-length; window edges; iteration cap;
- CalDAV layer with a mock `fetch`: discovery, version order-independence, calendar not found, iCloud 401 →
  `upstream_auth`, 5xx on one calendar → `query_failed` for it only;
- HTTP layer: 401 / 405 / 400 cases, constant-time compare path, cache hit and miss with a fake `caches`, a spy on
  `console` proving no token, password or ICS text is logged;
- a CPU benchmark: a synthetic calendar of ~300 events including a daily series started years ago; report
  milliseconds (see open question 1);
- bundling check: `npx wrangler deploy --dry-run --outdir <scratch>` (builds locally, uploads nothing).

Apps Script (`tests/apps-script/`, `node:test` + `vm` with mocks of `UrlFetchApp`, `PropertiesService`, `console`):

- provider: mapping of timed and all-day; key format; `ok: false` on HTTP error, non-JSON, top-level `ok: false`,
  missing calendar, invalid interval; partial intervals still returned; no property writes on failure or `dryRun`;
- `checkICloudAndSync` decision table: not configured, no change, changed, daily, back-off, `/version` failure,
  health-check throw;
- `node --check` on every `scripts/*.gs` copied to `.js` in a scratch folder.

## 13. What context7 confirmed or contradicted

| Item | Source | Result |
|---|---|---|
| `UrlFetchApp.fetch` methods: get, delete, patch, post, put only | context7 (Apps Script reference) | confirmed: no PROPFIND/REPORT → Worker needed |
| `UrlFetchApp` `headers`, `muteHttpExceptions`, `getResponseCode`, `getContentText` | context7 | confirmed |
| `UrlFetchApp` `timeoutSeconds` (default 360) | context7 | **new**: listed for `fetch()`; used for short timeouts |
| URL Fetch limits: 20,000 calls/day, URL ≤ 2 KB, 100 headers | context7 | confirmed; our URLs are short |
| `PropertiesService` script properties; 9 KB/value, 500 KB/store, 50,000 r/w per day | context7 | confirmed |
| `LockService.getScriptLock().tryLock()` returns false on timeout | context7 | confirmed; re-entrancy not documented → no nested lock |
| `everyMinutes(n)`: n ∈ {1, 5, 10, 15, 30} | context7 | confirmed |
| Trigger runtime 90 min/day (consumer); 6 min/execution | context7 | confirmed; 1-min trigger still rejected |
| Trigger failure → email to owner | context7 | confirmed; used as the 24 h alarm |
| Time-driven triggers' timing is slightly randomized | context7 | confirmed; 5 min is approximate |
| `ScriptApp.newTrigger` needs `script.scriptapp` scope | context7 | confirmed → create the trigger in the UI |
| `Utilities.computeHmacSha256Signature(value, key)` → `Byte[]` | context7 | confirmed (MirrorBusy) |
| Calendar advanced service: `start: { dateTime: toISOString() }` accepted | context7 | confirmed |
| Workers `fetch`: all methods except CONNECT | context7 (Workers Request docs) | confirmed |
| Workers secrets via `wrangler secret put`, `.dev.vars` for local, `secrets.required` | context7 | confirmed |
| Workers Free plan: **10 ms CPU per request**; 50 subrequests | context7 (limits) | **new risk**, see open question 1 |
| Cache API: GET keys only; `match` never hits origin | context7 | confirmed |
| Cache API on `workers.dev` | context7 | **contradictory pages** → cache is best effort |
| `crypto.subtle.timingSafeEqual`, hash both values first | context7 (Workers examples, best practices) | confirmed |
| `Intl` available; runtime clock is UTC | context7 | confirmed |
| `wrangler.jsonc`: `main`, `compatibility_date`, `observability` | context7 | confirmed |
| tsdav: Workers-compatible, native fetch, iCloud Basic auth, `fetchCalendars` gives `ctag`, `calendarQuery`, `expand` optional | context7 (`/natelindev/tsdav`) | confirmed; earlier "tsdav missing from context7" is fixed |
| ical.js: `Event`, `relateException`, `iterator` (RDATE/EXDATE), `getOccurrenceDetails` (incl. THISANDFUTURE), TZID from VTIMEZONE in the tree | context7 (`/kewisch/ical.js`) | confirmed; earlier "ical.js missing" is fixed |
| rrule.js | context7 | **not in context7**; not needed (ical.js expands) |
| RFC 4791 (calendar-query, time-range, expand), RFC 5545 | context7 | **not in context7** → official IETF datatracker text, marked |
| `getctag` (`http://calendarserver.org/ns/`) changes on any add/modify/delete | official calendarserver doc (not context7) | confirmed |
| iCloud ignores `<C:expand>` | community reports only | unconfirmed; design doesn't depend on it |

### Changes to the earlier design caused by these checks

1. **Cache:** the earlier "cache `/busy` for ~60 s" becomes a ctag-keyed cache (valid until something changes), and
   it is explicitly optional because the docs disagree about `workers.dev`.
2. **CPU limit:** the Free plan's 10 ms CPU per request was not in the earlier design. Parsing and expanding a year
   of events can exceed it; the cache makes the heavy path rare but not impossible.
3. **Daily full sync** uses the 5-minute function instead of a second trigger.
4. **Back-off and alarm** added so a broken iCloud read neither burns the trigger quota nor silently blocks all proxy
   deletions.
5. **Timeouts:** `timeoutSeconds` (newly listed in the docs) gives short, explicit fetch timeouts.
6. **Read-back format:** MirrorBusy should compare instants, not strings.

## 14. File layout

```
worker/
  wrangler.jsonc          name, main, compatibility_date, observability, workers_dev (secret names in a comment)
  package.json            exact versions: tsdav, ical.js; dev: wrangler
  .gitignore              node_modules/, .wrangler/, .dev.vars
  .dev.vars.example       secret names only
  README.md               local dev, tests, deploy and secrets commands
  src/index.js            router, auth, validation, cache, JSON responses, safe logging
  src/caldav.js           tsdav discovery, ctag version, calendar-query
  src/expand.js           ICS → intervals (recurrence, zones, all-day, skip rules)
  test/*.test.js          node:test suites, iCloud mock, synthetic fixtures; test/bench.mjs CPU benchmark
scripts/ICloudSource.gs   fetchICloudBusyIntervals, checkICloudAndSync, debugICloud
scripts/Config.gs.example + ICLOUD_CALENDARS, ICLOUD_FLOATING_TIMEZONE (MIRROR_EXTRA_PROVIDERS comes with MirrorBusy)
tests/apps-script/*.test.js
docs/icloud-setup.md      the owner's steps (§15) in full
README.md                 short "iCloud → proxy" section linking the setup doc
```

`worker/` and `tests/` are outside `scripts/`, so `clasp push` never uploads them. No changes to
`SyncCalendarsIntoOne.gs` are needed; MirrorBusy calls the provider. The repo ignores `package-lock.json`, so versions
are pinned exactly in `package.json`.

## 15. Owner's setup steps, in order

1. **Apple:** account.apple.com → Sign-In and Security → App-Specific Passwords → create one labelled for this Worker.
2. **Token:** `openssl rand -base64 32`; keep it in the password manager.
3. **Cloudflare:** Free plan first (see §17), turn on 2FA. In `worker/`: `npm install`, `npx wrangler login`, `npx wrangler deploy`, then
   `npx wrangler secret put ICLOUD_APPLE_ID`, `… ICLOUD_APP_PASSWORD`, `… FEED_TOKEN` (each put publishes a new
   version; until all three exist the Worker answers `not_configured`). Note the Worker URL.
4. **Check the Worker** with `curl` (§11): `/version` returns `ok: true` for the chosen calendars; `/busy` for a week
   returns plausible counts.
5. **Apps Script → Script Properties:** `ICLOUD_FEED_URL`, `ICLOUD_FEED_TOKEN`.
6. **Config:** refresh the local `Config.gs` from the live project first (the local copy is stale), then set
   `ICLOUD_CALENDARS` and `ICLOUD_FLOATING_TIMEZONE`. Leave `MIRROR_EXTRA_PROVIDERS` empty for now.
7. **Push and deploy** the Apps Script code as in `docs/updating-deployments.md`.
8. **Run `debugICloud`** in the editor; check the counts and a few times against the iPhone/Mac calendar.
9. **Enable in the proxy** (after MirrorBusy is merged and working for Google sources): set
   `MIRROR_EXTRA_PROVIDERS = ["fetchICloudBusyIntervals"]`, push, run MirrorBusy's dry run, then
   `SyncCalendarsIntoOne` once.
10. **Trigger:** Apps Script → Triggers → `checkICloudAndSync`, Head, Time-driven, Minutes timer, Every 5 minutes;
    failure notifications daily.
11. **Live test:** create a test event in a chosen iCloud calendar → a `Busy` event with no title appears in the proxy
    within ~5 minutes; move it → it moves; delete it → it disappears. Failure test: put a wrong
    `ICLOUD_FEED_TOKEN`, run `checkICloudAndSync` → log shows the failure and no proxy event is deleted; restore it.
12. **Rotation, when needed:** new app-specific password → `wrangler secret put ICLOUD_APP_PASSWORD` → revoke the old
    one at account.apple.com. New feed token → Worker secret first, then the Script Property.

## 16. Open questions for the owner

1. **Cloudflare plan.** Free gives 10 ms CPU per request. *Decided after the phase 2 benchmark (§17): read only
   today + 30 days, stay on Free, and check Exceeded CPU Time Limits after a day. If overruns are regular: a
   shorter horizon, Deno Deploy, or Workers Paid.*
2. **Commit the tests** in `worker/test/` and `tests/apps-script/` (proposed: yes, they contain only synthetic data).
3. **Alarm by thrown error** after 24 h without a successful iCloud read, giving Google's failure email (proposed: yes).

## 17. Phase 2: what changed during the build

1. **CPU benchmark → horizon + Free.** `worker/test/bench.mjs [days]` runs the real handler (XML parsing and
   expansion) on a synthetic calendar: about one event a day, two daily series running for years, two weekly series
   with 20 moves and two EXDATEs each. Like iCloud's time-range filter, only objects that can overlap the window are
   returned. On a recent Mac (Node 24, the same V8 family as workerd):

   | Request | 1st call on fresh code | 2nd | 3rd | Warm median |
   |---|---|---|---|---|
   | first build: `/busy`, 396 days, no time-range filtering in the mock | 858 ms | | | 545 ms |
   | `/version` | ~17 ms | ~4 ms | ~3 ms | ~1.5 ms |
   | `/busy`, 366 days ahead | ~135 ms | ~80 ms | ~48 ms | ~39 ms |
   | **`/busy`, 30 days ahead (default)** | **~50 ms** | **~28 ms** | **~20 ms** | **~7 ms** |
   | `/busy`, 7 days ahead | ~45 ms | ~18 ms | ~20 ms | ~5 ms |

   "1st call" excludes Node's own warm-up (Request/Response, WebCrypto and Intl are JS in Node, built in in
   workerd) and module loading (Workers count that as startup, with a separate 1 s limit). An earlier version of
   the benchmark included both and reported ~100 ms "cold" at 30 days.

   What Cloudflare's limits docs say (checked in context7): 10 ms of CPU per HTTP request on Free; waiting on the
   network doesn't count; startup has its own 1 s limit; and "each isolate has some built-in flexibility" for a
   Worker that infrequently runs over, while one that hits the limit consistently is terminated. Over the limit →
   error 1102, shown under Metrics → Errors → Invocation Statuses → Exceeded CPU Time Limits. So `/version` (every
   5 minutes) fits; `/busy` (rare, so often on code that isn't warm yet) will often go over, and only production
   shows whether that counts as infrequent. Decision: stay on Free, check the metric after a day (setup step 10a).
   Fallbacks: a shorter horizon; Deno Deploy's free plan (1M requests and 10 h active CPU a month, no per-request
   CPU limit listed on its pricing page; not yet checked against its limits page); Vercel Hobby (1M invocations,
   4 h active CPU); Workers Paid. A local `wrangler dev` (workerd) smoke test against the mock behaved like Node.
   The optimizations:
   - **Shared VTIMEZONEs.** Every iCloud object repeats the same VTIMEZONE, and ical.js expands its DST rules from
     1970 the first time each copy is used. One hydrated zone per distinct VTIMEZONE text is now shared across
     objects (via the root component's `_timezoneCache`; ical.js is pinned to 2.2.1, and the tests would catch a
     change). Single events: 410 ms → 22 ms.
   - **Fast-forward** for long series. With exactly one RRULE, FREQ=DAILY or WEEKLY, no COUNT and no BY rule other
     than BYDAY, DTSTART is moved forward by whole periods to just before the window. A test proves the output is
     identical to full iteration (interval, WKST, BYDAY, UNTIL, DST, EXDATE, overrides, THISANDFUTURE).
   - **No details lookup** for occurrences that end before the window (cheap wall-clock pre-check).
   - **Fast VTIMEZONE offsets.** ical.js's `Timezone.utcOffset()` deep-clones change records on every call, and
     ical.js calls it constantly (`toUnixTime`, `compare`, `convertToZone`, inside the iterator). The zones this
     module hydrates get a `utcOffset` that binary-searches a table of UTC transitions built once from the changes
     ical.js expands. A test compares it with ical.js's own `utcOffset` at ~80,000 local times from 2015 to 2030;
     DST edges follow RFC 5545.
   - **Overrides and plain occurrences without per-occurrence zone work:** override recurrence ids are kept as a
     set of instants, and for series without THISANDFUTURE overrides an occurrence is start + the series'
     duration (what `getOccurrenceDetails` does, minus its per-call cost).
2. **RDATE without RRULE:** ical.js does not yield DTSTART as the first instance; the Worker adds it (RFC 5545:
   DTSTART is always the first instance unless excluded).
3. **Calendar listing** uses `propfind` instead of `fetchCalendars` (§4) to save one subrequest per calendar.
4. **Cache key** on the Worker's own origin instead of `cache.invalid` (§6.1).
5. **Provider guard** in `checkICloudAndSync` (§7.2).
6. **No `secrets.required`** in `wrangler.jsonc` (§8.3).
7. **DST edge rules** for TZIDs without VTIMEZONE (Intl path), per RFC 5545 §3.3.5: a repeated local time means
   the first occurrence; a skipped one is read with the offset from before the jump.
8. **Duplicate display names:** if several iCloud calendars share a requested name, all are read (union) and all
   their ctags go into the version, so nothing is silently dropped.
9. **Versions:** tsdav 2.5.0, ical.js 2.2.1, wrangler 4.156.2 (at least two weeks old at build time), pinned exactly.
10. **Tests:** `npm test` at the repo root runs `tests/apps-script` (30 tests, including `node --check` on every
    `.gs`) and `worker/test` (53 tests). No network: the CalDAV tests use an in-memory iCloud mock on `.invalid`
    hosts.
11. **Horizon** in `fetchICloudBusyIntervals` (§7.1) and `coverage` in the provider result (§9), from the owner's
    decision to stay on Free.

## 18. Browser-only setup (owner's decision 2026-11-17; built)

The owner wants a setup that people without a terminal can follow, matching
[`setup-ui-based.md`](./setup-ui-based.md). The Worker stays, so only "Busy" leaves iCloud. Node, npm, wrangler,
openssl and clasp drop out of the owner's path; `worker/README.md` keeps the CLI path for developers.

### 18.1 What the person does

1. **Apple:** create an app-specific password (account.apple.com).
2. **Apps Script:** add `ICloudSource.gs` like the other files; in `Config.gs` set `ICLOUD_FLOATING_TIMEZONE` and,
   if wanted, `ICLOUD_CALENDARS`. Run `setupICloud`. It creates the feed token in Script Properties and says
   where to copy it (Project Settings → Script Properties). It never logs the token.
3. **Cloudflare:** click "Deploy to Cloudflare" in the README, sign in, connect GitHub, fill in three fields
   (Apple ID, app password, feed token), deploy. Copy the `workers.dev` URL.
4. **Apps Script:** paste the URL into `Config.gs` (`ICLOUD_FEED_URL`), run `setupICloud` again. It checks the
   Worker, lists the iCloud calendar names, shows the next 7 days of busy time, and creates the 5-minute trigger.

### 18.2 What changes in the code

- **Worker:** `GET /calendars` returns the event calendars' display names (auth as before). `calendars` may be
  `*` for all event calendars, so `ICLOUD_CALENDARS = []` means "all". `package.json` gets `cloudflare.bindings`
  descriptions for the three secrets and `"packageManager": "npm@<exact local version>"`, so Workers Builds' `npm ci`
  matches the lockfile. `.dev.vars.example` keeps one `NAME=` line per secret.
- **Apps Script:** `setupICloud()` (idempotent: creates the token only if missing, replaces any existing
  `checkICloudAndSync` trigger). `ICLOUD_FEED_URL` moves from Script Properties to `Config.gs` (it holds no
  secret; the token stays in Script Properties). `appsscript.json` gets the `script.scriptapp` scope.
- **Docs:** `icloud-setup.md` is rewritten around §18.1; README gets the button.

As built: `setupICloud` prints the calendar list and stops if a configured name is missing; with "all" and more
than 10 calendars it asks to name them; it creates the trigger only once `fetchICloudBusyIntervals` is in
`MIRROR_EXTRA_PROVIDERS` (otherwise `checkICloudAndSync` would only log warnings). The token is 64 hex characters
from two `Utilities.getUuid()` values. Worker error messages (`message` in a 400) now reach the Apps Script log.
Tests: 40 Apps Script, 58 Worker.

### 18.3 Checked against the docs (context7 and Cloudflare docs, 2026-11-17)

| Claim | Source | Result |
|---|---|---|
| Deploy button takes a repo subdirectory; the subdirectory must be self-contained and becomes the new repo's root | Cloudflare "Deploy to Cloudflare buttons" | confirmed; `worker/` has its own `package.json` and lockfile |
| The button clones into the person's GitHub/GitLab (private repo allowed), builds with Workers Builds, deploys | same | confirmed; a GitHub or GitLab account is required |
| Secrets listed in `.dev.vars.example` are asked for in the dashboard during deploy; `package.json` `cloudflare.bindings` adds descriptions | Cloudflare changelog 2025-07-29 | confirmed |
| Source repo must be public | Deploy buttons, Limitations | confirmed; this repo is public. The button reads `main`, so `worker/` must be on `main` first |
| Workers Builds: deploy command defaults to `npx wrangler deploy` with the wrangler from `package.json`; Free has 3,000 build minutes/month | Workers Builds configuration, limits | confirmed |
| Lockfile from a newer npm can break `npm ci` in Workers Builds; fix with `packageManager` | Workers Builds troubleshooting | confirmed, hence the pin |
| Every account has a `workers.dev` subdomain | workers.dev docs | confirmed |
| A standalone Apps Script project cannot add menus or dialogs (`getUi` is for bound scripts only) | Apps Script "bound scripts", `Ui` | confirmed, so setup is a function run from the editor, as in the base setup |
| A trigger can be created from code: `ScriptApp.newTrigger(...).timeBased().everyMinutes(5)`; `n` ∈ {1, 5, 10, 15, 30}; needs `script.scriptapp` | Apps Script reference | confirmed; the repo manifest lists scopes explicitly, so the scope must be added there |

Not provable from docs, only by a real run: how the deploy form looks for this repo, and that the three fields
land as Worker secrets. The owner's first run of §18.1 is that test.

### 18.4 Trade-offs

- The person needs Cloudflare and GitHub accounts.
- The deployed Worker is a copy in their GitHub. Worker fixes don't reach them on their own: they pull the change
  into their copy (Workers Builds redeploys on push) or redeploy with the button.
