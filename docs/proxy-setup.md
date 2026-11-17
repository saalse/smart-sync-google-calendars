# Proxy calendar with plain "Busy" (MirrorBusy): setup

Some booking tools only read the primary calendar of the Google account you connect to them. Sharing Busy Time with
that account doesn't help, because the tool ignores shared calendars, and connecting your real account would show it
every title, place and guest.

MirrorBusy solves this with a separate **proxy** Google account. You connect only the proxy to the booking tool.
At the end of every sync, MirrorBusy keeps one event in the proxy's **primary** calendar for each busy event in Busy
Time, and optionally for each busy interval from iCloud ([`icloud-setup.md`](./icloud-setup.md)). Each event is:

- titled `Busy`, with no place, notes, guests, conference link or reminders;
- private and shown as busy;
- at the same time as the original; all-day stays all-day.

The proxy never sees where an event came from. Each proxy event stores only two HMAC values, so apps connected to
the proxy (which can read private event properties) learn nothing from them. One thing they can see: each event's
creator is your main account (Google shows "Created by" with its address), because that account writes the events.

## What you need

- the Apps Script project from [`setup-ui-based.md`](./setup-ui-based.md), already syncing into Busy Time;
- a second Google account for the proxy (a free Gmail account is fine). Its primary calendar is the one the
  booking tool reads.

About 10 minutes.

## Steps

### 1. Proxy account: share its primary calendar with your main account

Sign in to [calendar.google.com](https://calendar.google.com) **as the proxy account**:

1. **Settings** (gear icon) → under **Settings for my calendars**, click the proxy's own calendar (its name is the
   account's name).
2. **Share with specific people or groups** → **Add people and groups** → type the address of your **main**
   account, the one that runs the Apps Script project.
3. **Permissions:** **Make changes and see all event details**. Click **Send**. Don't pick "Make changes (see
   private events as free/busy)": the proxy's Busy events are private, so that option would hide them from the script.
4. Optional, still as the proxy: under **Event notifications** of the same calendar, remove the default notification.
   Reminders belong to each person who sees a calendar, so MirrorBusy can switch them off only for your main account;
   without this step the proxy account gets a notification before every Busy event.

Then, in your **main** account's mailbox, open the email from Google Calendar and click the link to add the
calendar (or open `https://calendar.google.com/calendar/r?cid=<proxy address>` signed in as the main account). It
now shows under **Other calendars**.

This is the only share needed. Never add the proxy to `CALENDARS_TO_MERGE`: its Busy events would loop back into
Busy Time. MirrorBusy refuses to run if you do.

### 2. Apps Script: add the code

In the Apps Script project (the main account):

1. Click **+** → **Script**, name it `MirrorBusy`, and paste the whole of
   [`scripts/MirrorBusy.gs`](../scripts/MirrorBusy.gs).
2. Open `SyncCalendarsIntoOne.gs`, replace its contents with the current
   [`scripts/SyncCalendarsIntoOne.gs`](../scripts/SyncCalendarsIntoOne.gs). It calls MirrorBusy at the end of
   every sync.
3. At the end of `Config.gs`, add:
   ```js
   const MIRROR_BUSY_TO = "your-proxy-account@example.com"
   const MIRROR_EXTRA_PROVIDERS = []
   ```
   `MIRROR_BUSY_TO` is the proxy's address, which is also the ID of its primary calendar.
4. Save (⌘S / Ctrl+S).

With clasp (see [`setup-cli-based.md`](./setup-cli-based.md)): pull the live project first, so your local
`Config.gs` matches it, then add the two lines and push.

### 3. Run `setupMirrorBusy`

Open `MirrorBusy.gs`, pick `setupMirrorBusy` in the function list next to **Run**, and click **Run**. The log says:

- whether the proxy is shared with write access;
- `created MIRROR_KEY_SECRET` the first time (it lives in Script Properties; leave it alone);
- what the first sync will do: `MirrorBusy dry run: Busy Time 42 → proxy: 42 to create, …`, followed by the first
  planned events with their source (that list is only in your log, never in the proxy).

Nothing is written to any calendar yet. If the log asks for something (the share, the link in the email), do it
and run `setupMirrorBusy` again.

### 4. Run the sync once

Open `SyncCalendarsIntoOne.gs` and run `SyncCalendarsIntoOne`. The log ends with a line like:

```
MirrorBusy: Busy Time 42 → proxy: 42 created, 0 updated, 0 deleted, 0 unchanged
```

No new trigger is needed: your calendar triggers already run `SyncCalendarsIntoOne`, and every run now updates the
proxy too.

### 5. Check the proxy

Signed in as the proxy account, open Google Calendar. You should see `Busy` blocks at your busy times. Open one:
no place, no description, no guests, no video link, visibility **Private**, no notification.

Then a live test: create an event in one of your source calendars. Within a minute or two it appears in Busy Time
and as `Busy` in the proxy. Move it: the Busy block moves. Delete it: the Busy block disappears.

To see where each Busy came from, run `debugProxyDay` (in `MirrorBusy.gs`). It writes nothing. The log lists every
event in the proxy today, the source of each Busy, and any event MirrorBusy didn't write (for example a booking).
For another day, add a line at the end of any file, `function checkDay() { debugProxyDay("2026-11-20") }`, run
`checkDay`, and delete the line again.

## How it behaves

- **Window:** from yesterday to `SYNC_DAYS_IN_FUTURE` days ahead. Older proxy events are left alone.
- **Only what changed** is created, updated or deleted, in batch requests. The first run creates everything at
  once; if Google reports a rate limit, the rest follows with the next syncs.
- **Edits in the proxy are undone.** If someone changes a Busy event in the proxy (title, notes, guests, time), the
  next sync puts it back to plain `Busy`. Events MirrorBusy didn't write, such as bookings the booking tool creates
  in the proxy, are never touched.
- **A failed read never deletes.** If Busy Time or an extra source (iCloud) can't be read, nothing is deleted from
  the proxy in that run; new Busy events are still added. The log says `deletions skipped because a source failed`.
- **Skipped:** events marked free, cancelled events, working-location entries, and Busy Time events that came from
  the proxy itself.

## Changing things later

- **Add iCloud:** [`icloud-setup.md`](./icloud-setup.md), then put `"fetchICloudBusyIntervals"` into
  `MIRROR_EXTRA_PROVIDERS`.
- **See what the next sync would change:** run `dryRunMirrorBusy`. It writes nothing.
- **Turn the mirror off:** set `MIRROR_BUSY_TO = ""`. The Busy events already in the proxy stay; delete them in the
  proxy account if you want them gone.
- **`MIRROR_KEY_SECRET`:** never needed by you. If it changes or is deleted, the next sync replaces every proxy
  Busy event once.

## Troubleshooting

| Log line | Meaning | Fix |
|---|---|---|
| `cannot open the proxy calendar` | the share is missing | step 1 |
| `this account can only see … the proxy calendar` | shared, but read-only | step 1, permission **Make changes to events** |
| `access level is unknown because it is not in this account's calendar list` | the share email link wasn't clicked | step 1, last paragraph |
| `MIRROR_BUSY_TO is also in CALENDARS_TO_MERGE` | the proxy is set as a source | remove it from `CALENDARS_TO_MERGE` |
| `… FAILED (…)` in the `MirrorBusy:` line | a source couldn't be read; nothing was deleted | for iCloud see [`icloud-setup.md`](./icloud-setup.md#troubleshooting) |
| `N request(s) failed, retried at the next sync` | Google refused some writes (often a rate limit) | nothing; check that the count shrinks |
| no `MirrorBusy:` line at all | `MIRROR_BUSY_TO` is empty, or `MirrorBusy.gs` or the new `SyncCalendarsIntoOne.gs` is missing | step 2 |

---

Author: [Alex Samson](https://saalse.com).
