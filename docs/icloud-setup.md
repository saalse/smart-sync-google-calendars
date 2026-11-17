# iCloud busy time in the proxy calendar: setup

This guide shows busy time from your iCloud calendars in the proxy Google account's primary calendar, as plain
`Busy` events with no details. Booking tools that read only that calendar then see your iCloud commitments.

How it works: a small Cloudflare Worker reads iCloud and returns busy intervals only (no titles, places or
people). `ICloudSource.gs` in your Apps Script project fetches them, and MirrorBusy writes them into the proxy
calendar. Design and every rule: [`icloud-spec.md`](./icloud-spec.md).

Everything below happens in the browser. Developers who prefer the terminal: [`worker/README.md`](../worker/README.md).

**Before you start:** iCloud reaches the proxy only through **MirrorBusy**. Steps 1–5 work now and show you what
would be synced. Step 6 needs MirrorBusy set up for your Google calendars.

## What you need

- the Apps Script project from [`setup-ui-based.md`](./setup-ui-based.md), already working;
- an Apple ID with two-factor authentication (Apple requires it for app-specific passwords);
- a free **Cloudflare** account and a free **GitHub** account (GitLab works too). The Deploy button copies the
  Worker's code into your GitHub and runs it on your Cloudflare.

About 15 minutes.

## Steps

### 1. Apple: app-specific password

[account.apple.com](https://account.apple.com) → **Sign-In and Security** → **App-Specific Passwords** → create one,
named for example `icloud-busy-feed`. Keep the page open: Apple shows the password only once. Use it only for this
Worker. It is not limited to calendars (Apple also lets it read mail and contacts), which is why it lives only in
your Cloudflare account and never in Google.

### 2. Apps Script: add the iCloud file and settings

1. In your Apps Script project, click **+** → **Script**, name it `ICloudSource`, and paste the whole of
   [`scripts/ICloudSource.gs`](../scripts/ICloudSource.gs).
2. Open `Config.gs` and add the iCloud block from
   [`scripts/Config.gs.example`](../scripts/Config.gs.example)
   (the lines starting with `ICLOUD_`). For now leave `ICLOUD_FEED_URL = ""` and `ICLOUD_CALENDARS = []`, and set
   `ICLOUD_FLOATING_TIMEZONE` to your time zone, for example `"Europe/Berlin"`.
3. Save.

Using clasp instead? Push as in [`updating-deployments.md`](./updating-deployments.md). The repo's
`appsscript.json` already lists the trigger permission that setup needs.

### 3. Apps Script: run `setupICloud` (first time)

Pick `setupICloud` in the function list at the top of the editor and click **Run**. Google asks for permissions
again; the new one lets the script create its own trigger.

The log says it created the feed token. Open **Project Settings** (gear icon) → **Script Properties** and copy the
value of `ICLOUD_FEED_TOKEN`. You need it in the next step. It never appears in the log.

### 4. Cloudflare: deploy the Worker

Open the **Deploy to Cloudflare** button in the [README](../README.md#icloud--proxy-calendar-optional).

1. Sign in to Cloudflare, or create a free account. Turning on two-factor authentication for it is a good idea:
   your Apple password will live there.
2. Connect your GitHub account when asked. You can make the new repository private.
3. Keep the suggested names. Fill in the three fields:
   - `ICLOUD_APPLE_ID`: your Apple ID (email);
   - `ICLOUD_APP_PASSWORD`: the app-specific password from step 1;
   - `FEED_TOKEN`: the `ICLOUD_FEED_TOKEN` value from step 3.
4. Click **Create and deploy** and wait for the build to finish (a minute or two).
5. Copy the Worker's address. It looks like `https://icloud-busy-feed.<your-subdomain>.workers.dev`. You can
   always find it again in the Cloudflare dashboard under **Workers & Pages** → `icloud-busy-feed`.

Opening that address in a browser shows `{"ok":false,"error":"unauthorized"}`. That's correct: only your Apps
Script has the token.

### 5. Apps Script: run `setupICloud` again

Paste the address into `Config.gs`: `ICLOUD_FEED_URL = "https://icloud-busy-feed.<your-subdomain>.workers.dev"`.
Save, then run `setupICloud` again. The log shows:

- the names of your iCloud calendars;
- your busy time for the next 7 days, in your time zone.

Compare a few entries with Apple Calendar. By default all calendars are read. To read only some, copy their names
from the log into `ICLOUD_CALENDARS` (exactly, case and spaces count) and run `setupICloud` again. If you have more
than 10 calendars, you have to pick.

### 6. Turn it on in the proxy (after MirrorBusy is set up)

1. In `Config.gs`, add `"fetchICloudBusyIntervals"` to `MIRROR_EXTRA_PROVIDERS`.
2. Run MirrorBusy's dry run and check what it would add.
3. Run `setupICloud` once more. This time it also creates the trigger: `checkICloudAndSync` every 5 minutes.
4. Run `SyncCalendarsIntoOne` once.

Never add the proxy's own primary calendar to `CALENDARS_TO_MERGE`, or its Busy events would loop back.

### 7. Test it

**Live test:** create a test event in an iCloud calendar. Within about 5 minutes a `Busy` event with no title
appears in the proxy. Move it, and the Busy event moves. Delete it, and the Busy event disappears.

**Failure test:** in Script Properties, change one character of `ICLOUD_FEED_TOKEN`, run `checkICloudAndSync`,
and check that the log shows the failure and that no proxy event was deleted. Then undo the change.

### 8. After a day: check the Worker's CPU

Cloudflare's free plan allows 10 ms of CPU per request and tolerates occasional overruns. Cloudflare dashboard →
**Workers & Pages** → `icloud-busy-feed` → **Metrics** → Errors → Invocation Statuses: count **Exceeded CPU Time
Limits** (error 1102). In the Apps Script executions, look for `iCloud: FAILED (http …, not JSON)` or
`/version failed`. Occasional failures are harmless: the next check retries, and nothing is deleted in the
meantime. If they are regular, lower `ICLOUD_DAYS_AHEAD` in `Config.gs`, or move to Workers Paid.

## Changing things later

- **New Apple app-specific password:** Cloudflare dashboard → **Workers & Pages** → `icloud-busy-feed` →
  **Settings** → **Variables & Secrets** → edit `ICLOUD_APP_PASSWORD`. Then revoke the old one at account.apple.com.
- **New feed token:** delete `ICLOUD_FEED_TOKEN` in Script Properties, run `setupICloud` (it creates a new one), and
  put the new value into the Worker's `FEED_TOKEN` in the same Cloudflare page. iCloud reads fail in between, so
  nothing gets deleted.
- **Different calendars or time zone:** edit `Config.gs`, run `setupICloud` to check.
- **Worker updates:** your Worker runs from the copy in your GitHub and doesn't change on its own. To take a fix
  from this project, update your copy from it (Cloudflare redeploys on every push to your copy), or delete the
  Worker and deploy again with the button.
- **Turn iCloud off:** remove `"fetchICloudBusyIntervals"` from `MIRROR_EXTRA_PROVIDERS`, set `ICLOUD_FEED_URL = ""`,
  and delete the `checkICloudAndSync` trigger (Apps Script → **Triggers**).

The code keeps four more Script Properties for itself: `ICLOUD_LAST_VERSION`, `ICLOUD_LAST_OK_AT`,
`ICLOUD_LAST_FAILURE_AT`, `ICLOUD_LAST_RUN_AT`. Leave them alone, or delete them all to reset the state.

Never put the Apple ID, the passwords or the token into the repo or a shared file.

## How it behaves

- **Every 5 minutes** `checkICloudAndSync` asks the Worker whether any of your iCloud calendars changed. If so, it
  runs `SyncCalendarsIntoOne`. It also runs a full sync at least once a day.
- **Horizon:** only today and the next `ICLOUD_DAYS_AHEAD` days (default 30) are read. An event further away
  appears once it enters the horizon, at the latest with the next daily sync. iCloud Busy events that have passed
  may be removed from the proxy; booking doesn't need them.
- **When iCloud can't be read** (wrong token, Apple password revoked, iCloud down, a renamed calendar, an event
  the Worker can't parse), the read counts as failed. MirrorBusy then **deletes nothing** from the proxy, not even
  events from your Google calendars, while still adding new ones. The next attempt waits 15 minutes.
- **After 24 hours without a successful iCloud read**, `checkICloudAndSync` fails on purpose, so Google emails you
  about the failing trigger. Run `setupICloud` or `debugICloud` to see why.

## Troubleshooting

`setupICloud` explains the common problems in its log. The table covers the lines you may see later:

| Log line | Meaning | Fix |
|---|---|---|
| `iCloud check: not configured (ICLOUD_FEED_URL is not set in Config.gs)` | step 5 not done | step 5 |
| `iCloud check: fetchICloudBusyIntervals is not in MIRROR_EXTRA_PROVIDERS` | iCloud isn't turned on in MirrorBusy | step 6 |
| `iCloud: FAILED (http 401 unauthorized)` | `ICLOUD_FEED_TOKEN` ≠ the Worker's `FEED_TOKEN` | copy the token again (step 3 → Cloudflare Variables & Secrets) |
| `iCloud: FAILED (http 502 upstream_auth)` | Apple rejected the Apple ID or app password | new app-specific password, see "Changing things later" |
| `iCloud: FAILED (http 500 not_configured)` | a Worker secret is missing | Cloudflare → Variables & Secrets: all three must exist |
| `…: failed (not_found)` | no iCloud calendar has that exact name | run `setupICloud`, copy the name from its list |
| `…: failed (parse_failed)` | the Worker could not read an event in that calendar | Cloudflare → the Worker → Logs; open an issue with the calendar app and event type (never the event itself) |
| `iCloud: FAILED (http 400 bad_request: more than 10 calendars; name them)` | `ICLOUD_CALENDARS` is empty and you have more than 10 | list up to 10 names |
| `iCloud: FAILED (http …, not JSON)` | Cloudflare error page, e.g. error 1102 (CPU limit exceeded) | if regular: step 8 |
| `requested window is outside the iCloud horizon` | the caller asked only for dates beyond `ICLOUD_DAYS_AHEAD` | nothing to fix |
| `iCloud check: backing off …` | a read failed less than 15 minutes ago | wait, or fix the cause above |
