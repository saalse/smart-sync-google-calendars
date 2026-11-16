# iCloud busy time in the proxy calendar: setup

This guide shows busy time from chosen iCloud calendars in the proxy Google account's primary calendar, as plain
`Busy` events with no details. Booking tools that read only that calendar then see your iCloud commitments.

How it works: a small Cloudflare Worker (`worker/`) reads iCloud over CalDAV and returns busy intervals only.
`scripts/ICloudSource.gs` fetches them, and MirrorBusy writes them into the proxy calendar. iCloud never goes into
Busy Time. Design and every rule: [`icloud-spec.md`](./icloud-spec.md).

**Before you start:** iCloud reaches the proxy only through **MirrorBusy**. You can do steps 1–8 now. Step 9 and
later need MirrorBusy merged and working for your Google calendars.

## What goes where

| Where | Name | Value |
|---|---|---|
| Worker secret | `ICLOUD_APPLE_ID` | your Apple ID |
| Worker secret | `ICLOUD_APP_PASSWORD` | app-specific password for this Worker only |
| Worker secret | `FEED_TOKEN` | random token (step 2) |
| Script Property | `ICLOUD_FEED_URL` | Worker URL, e.g. `https://icloud-busy-feed.<your-subdomain>.workers.dev` (no trailing slash, no token) |
| Script Property | `ICLOUD_FEED_TOKEN` | same value as `FEED_TOKEN` |
| `Config.gs` | `ICLOUD_CALENDARS` | iCloud calendar names, exactly as shown in Apple Calendar |
| `Config.gs` | `ICLOUD_FLOATING_TIMEZONE` | IANA zone for events without a time zone, e.g. `Europe/Berlin` |
| `Config.gs` | `ICLOUD_DAYS_AHEAD` | how many days ahead to read (default 30; the past is never read) |
| `Config.gs` | `MIRROR_EXTRA_PROVIDERS` | add `"fetchICloudBusyIntervals"` (step 9) |

The code fills in four more Script Properties itself: `ICLOUD_LAST_VERSION`, `ICLOUD_LAST_OK_AT`,
`ICLOUD_LAST_FAILURE_AT`, `ICLOUD_LAST_RUN_AT`. Leave them alone, or delete them all to reset the state.

Never put the Apple ID, the passwords, the token or the Worker URL in the repo.

## Steps

1. **Apple app-specific password.** account.apple.com → Sign-In and Security → App-Specific Passwords → create
   one labelled for this Worker. Use it only here. It is not limited to calendars (Apple lets it read mail and
   contacts too), so it lives only in the Worker.

2. **Feed token.** Generate one and keep it in your password manager:
   ```bash
   openssl rand -base64 32
   ```

3. **Cloudflare Worker.** Turn on 2FA for the Cloudflare account. Start on the **Free** plan (10 ms of CPU per
   request): with the default 30-day horizon, a warm Worker needs about 7–8 ms per `/busy` in the benchmark
   (`npm run bench` in `worker/`). A request that lands on a freshly started Worker can need much more (about
   100 ms in the benchmark, mostly one-off compilation of the library code), so check step 10a after a day. Then,
   in `worker/`:
   ```bash
   npm install
   ```
   ```bash
   npx wrangler login
   ```
   ```bash
   npx wrangler deploy
   ```
   Write down the `workers.dev` URL that `deploy` prints. Then set the three secrets (each command asks for the
   value):
   ```bash
   npx wrangler secret put ICLOUD_APPLE_ID
   ```
   ```bash
   npx wrangler secret put ICLOUD_APP_PASSWORD
   ```
   ```bash
   npx wrangler secret put FEED_TOKEN
   ```

4. **Check the Worker from your terminal.** `read -rs` keeps the token out of shell history:
   ```bash
   read -rs FEED_TOKEN && export FEED_TOKEN
   ```
   ```bash
   curl -sS -H "Authorization: Bearer $FEED_TOKEN" "https://icloud-busy-feed.<your-subdomain>.workers.dev/version?calendars=Calendar%20A"
   ```
   ```bash
   curl -sS -H "Authorization: Bearer $FEED_TOKEN" "https://icloud-busy-feed.<your-subdomain>.workers.dev/busy?calendars=Calendar%20A&start=2026-11-17T00:00:00Z&end=2026-11-24T00:00:00Z"
   ```
   `/version` should say `"ok":true` for every calendar, and `/busy` should show plausible intervals. A
   `not_found` usually means the name differs from Apple Calendar (case and spaces count). In a URL, a space is
   `%20` and `+` is `%2B`.

5. **Script Properties.** Apps Script editor → Project Settings → Script Properties: add `ICLOUD_FEED_URL` and
   `ICLOUD_FEED_TOKEN`.

6. **Config.gs.** First refresh your local `Config.gs` from the live project (the local copy may be stale). Then
   set `ICLOUD_CALENDARS` and `ICLOUD_FLOATING_TIMEZONE` (see `Config.gs.example`). Do not add
   `fetchICloudBusyIntervals` to `MIRROR_EXTRA_PROVIDERS` yet. Never add the proxy's own primary calendar to
   `CALENDARS_TO_MERGE`, or its Busy events would loop back.

7. **Push the Apps Script code**, following [`updating-deployments.md`](./updating-deployments.md).

8. **Run `debugICloud`** in the editor. It prints the state, `/version` and every interval of the next 7 days in
   your time zone, and it writes nothing. Compare a few entries with Apple Calendar on your phone or Mac.

9. **Turn it on in the proxy** (only after MirrorBusy is merged and working). Set
   `MIRROR_EXTRA_PROVIDERS = ["fetchICloudBusyIntervals"]` in `Config.gs`, push, run MirrorBusy's dry run, then
   run `SyncCalendarsIntoOne` once.

10. **Trigger.** Apps Script → Triggers → Add trigger: function `checkICloudAndSync`, deployment Head, event
    source Time-driven, Minutes timer, Every 5 minutes. Set failure notifications to daily.

10a. **After a day, check the Worker's CPU.** Cloudflare dashboard → Workers & Pages → `icloud-busy-feed` →
    Metrics: look at CPU time and at errors for exceeded resource limits. In the Apps Script executions, look for
    `iCloud: FAILED (http 503, not JSON)` or `/version failed`. Occasional failures are harmless: the next
    check retries and nothing is deleted meanwhile. If they are frequent, shorten `ICLOUD_DAYS_AHEAD`, or switch
    the Worker to **Workers Paid** (the code stays the same).

11. **Live test.** Create a test event in a chosen iCloud calendar. Within about 5 minutes a `Busy` event with no
    title should appear in the proxy. Move it, and the Busy event moves. Delete it, and the Busy event
    disappears.
    **Failure test:** put a wrong `ICLOUD_FEED_TOKEN`, run `checkICloudAndSync`, and check that the log shows the
    failure and that no proxy event was deleted. Then put the right token back.

12. **Rotation, when needed.**
    - New app-specific password: run `npx wrangler secret put ICLOUD_APP_PASSWORD` with the new one, then revoke
      the old one at account.apple.com.
    - New feed token: set the Worker secret `FEED_TOKEN` first, then the Script Property `ICLOUD_FEED_TOKEN`.
      Reads fail in between, so nothing gets deleted.

## How it behaves

- **Every 5 minutes** `checkICloudAndSync` asks the Worker's cheap `/version`. If any chosen calendar changed, it
  runs `SyncCalendarsIntoOne`. It also runs a full sync at least once a day.
- **Horizon:** only the next `ICLOUD_DAYS_AHEAD` days (plus today) are read. An event that is further away
  appears once it enters the horizon, at the latest with the next daily sync. iCloud Busy events that have
  passed may be removed from the proxy; booking doesn't need them.
- **When iCloud can't be read** (wrong token, Apple password revoked, iCloud down, a renamed calendar, an event
  the Worker can't parse), the read counts as failed. MirrorBusy then **deletes nothing** from the proxy, not even
  events from your Google calendars, while still adding new ones. The next attempt waits 15 minutes.
- **After 24 hours without a successful iCloud read**, `checkICloudAndSync` fails on purpose, so Google emails you
  about the failing trigger. Run `debugICloud` to see why.

## Troubleshooting

| Log line | Meaning | Fix |
|---|---|---|
| `iCloud check: not configured (…)` | a Config key or Script Property is missing | steps 5–6 |
| `iCloud check: fetchICloudBusyIntervals is not in MIRROR_EXTRA_PROVIDERS` | iCloud isn't turned on in MirrorBusy | step 9 |
| `iCloud: FAILED (http 401 unauthorized)` | `ICLOUD_FEED_TOKEN` ≠ Worker `FEED_TOKEN` | set both again |
| `iCloud: FAILED (http 502 upstream_auth)` | Apple rejected the Apple ID or app password | step 1, then `wrangler secret put` |
| `iCloud: FAILED (http 500 not_configured)` | a Worker secret is missing | step 3 |
| `…: failed (not_found)` | no iCloud calendar has that exact name | fix `ICLOUD_CALENDARS` |
| `…: failed (parse_failed)` | the Worker could not read an event in that calendar | `npx wrangler tail`, then open an issue with the calendar app and event type (never the event itself) |
| `iCloud: FAILED (http 503, not JSON)` | Cloudflare error page, e.g. CPU limit exceeded | if frequent: shorter `ICLOUD_DAYS_AHEAD` or Workers Paid (step 10a) |
| `iCloud check: /version failed (http 503, not JSON)` | same, on the cheap check | same |
| `requested window is outside the iCloud horizon` | the caller asked only for dates beyond `ICLOUD_DAYS_AHEAD` | nothing to fix |
| `iCloud check: backing off …` | a read failed less than 15 minutes ago | wait, or fix the cause above |
