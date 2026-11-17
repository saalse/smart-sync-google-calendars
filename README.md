# Smart Sync Google Calendars

A free, secure, and unlimited solution to sync multiple Google calendars into one unified "Busy Time" calendar using Google Apps Script.

## Why This Project?

**The Problem:** Active lifestyle, flexible schedule, remote work culture. When you have multiple calendar accounts (I'm juggling 4 at the moment, so I know what I'm talking about), sharing real availability becomes a mess. You need automation that shows your actual busy/free time to both family and teammates without compromising privacy or flexibility.

**Why Not Calendly and other SaaS Solutions?**
- 🔒 **Privacy concerns** - Full calendar access to third parties. You have to pray they don't sell your data and actually care about security (usually, they don't)
- 🔗 **Not native** - Recipients must click external links instead of seeing your schedule directly in their calendar
- 📧 **Single calendar limitation** - Must choose one "main" calendar for invitations, losing flexibility
- 💰 **You have to pay** for simple feature just for syncing busy/free time

**Why Not Zapier?**
Complex setup, recurring costs, and limitations when Google Calendar API + Apps Script natively supports everything for free.

**How I Got Here:**  
After trying everything, I found [Sync Multiple Google Calendars by karbassi](https://github.com/karbassi/sync-multiple-google-calendars). Loved the concept, but it wasn't suitable for active life with many events and far-ahead planning culture. The delete-and-recreate approach was hitting Google's API limits daily. 

So I used Cursor to completely rewrite the algorithm, making it sync each event individually on create/change/delete. Now it handles any busy bee schedule within API limitations. 

## Key Features

- ✅ **Smart sync by changes only** - Updates, creates, or deletes only what changed
- ✅ **Year-ahead syncing that works** - 365 days future without hitting API limits
- ✅ **Multiple source calendars** - Sync from unlimited calendars simultaneously
- ✅ **Fast & efficient** - < 30 seconds typical runtime, uses batch API requests
- ✅ **Event-based triggers** - Syncs automatically when calendars update (near-instant)
- ✅ **Smart filtering** - Skips "free" events, preserves locations
- ✅ **Free & unlimited** - No third-party services or subscriptions
- ✅ **Duplicate Prevention**: Handles concurrent executions safely with LockService
- ✅ **Timezone independent** - Works regardless of where you travel
- ✅ **Developer-friendly** - Open source, well-documented, CLI setup for AI agents

### Privacy & Security

- ✅ **No data sharing**: Events never leave your Google account
- ✅ **Privacy-focused** - Runs entirely in your Google account, no external servers
- ✅ **You're in control**: Open source, modify as needed
- ✅ **Secure by default**: Uses Google's OAuth for authentication

## Getting Started

Choose your setup method:

- **[UI-Based Setup](./docs/setup-ui-based.md)** ← Start here! Browser-only, no command-line tools needed
- **[CLI-Based Setup](./docs/setup-cli-based.md)** ← For developers who want local editing and Git workflow, with [clasp](https://github.com/google/clasp), the Apps Script CLI to streamline development with AI coding agents.


## How Smart Sync Works

The sync uses an intelligent update approach that only modifies events that have actually changed:

1. **Trigger fires** when any source calendar updates (or on schedule)
2. **Fetch phase**: Get events from all source calendars and the busy calendar
3. **Compare phase**: Match events using tracking metadata and compare content
4. **Categorize phase**: Events are categorized as:
   - **Create**: New events that don't exist yet
   - **Update**: Existing events that have changed (title, time, location, etc.)
   - **Delete**: Events removed from source calendars
   - **Skip**: Unchanged events (no API calls needed)
5. **Execute phase**: Only create, update, or delete events that actually changed
6. **Done**: Changes appear in target calendar with minimal API usage

### What Gets Synced

| Data | Synced? | Notes |
|------|---------|-------|
| Event title | ✅ Yes | With prefix like `[personal]` |
| Start/end time | ✅ Yes | Preserves original timezone |
| Location | ✅ Yes | For context |
| Conference links | ✅ Yes | Zoom, Meet, etc. |
| Description | ❌ No | Privacy |
| Attendees | ❌ No | Privacy |
| Free/transparent events | ❌ No | Not shown as busy |

### Technical Implementation Details

For developers interested in how the smart sync works under the hood:

- **Event Tracking**: Uses Google Calendar's `extendedProperties.private` to store:
  - `sourceCalendarId` - Which source calendar the event came from
  - `sourceEventId` - Original event ID in the source calendar
  - `sourceLastModified` - Timestamp for tracking changes
  - `syncVersion` - Schema version for future compatibility

- **Matching Logic**: Creates composite keys (`calendarId:eventId`) to match source events with synced events, enabling O(1) lookups during comparison

- **Change Detection**: Compares these fields to determine if an update is needed:
  - Title (with calendar prefix like `[personal]`)
  - Start/end times (including `dateTime`, `date`, and `timeZone`)
  - Location
  - Conference data (Zoom, Meet links, etc.)

- **Duplicate Prevention**: Multi-layer deduplication strategy:
  - Content-based hashing (calendar + time + title + location)
  - In-memory deduplication during categorization
  - Live calendar queries for concurrent execution safety

- **Error Handling**: Calendar access failures (permissions revoked, calendar deleted) are caught and logged. Events from inaccessible calendars remain in the busy calendar until access is restored, preventing accidental deletion.

- **Pagination Support**: Handles calendars with 2,500+ events by processing multiple pages of results from the Calendar API

## Proxy calendar with plain "Busy" (optional)

Some booking tools read only the primary calendar of the Google account you connect, and ignore shared calendars.
**MirrorBusy** (`scripts/MirrorBusy.gs`) keeps a separate proxy account's primary calendar filled with one `Busy`
event per busy event in Busy Time: private, no place, notes, guests, conference link or reminders. It runs at the end
of every sync, changes only what changed, undoes edits made in the proxy, never touches the proxy's own events
(bookings), and deletes nothing while any source failed to load. One share from the proxy ("Make changes to
events") is all it needs: [`docs/proxy-setup.md`](./docs/proxy-setup.md).

## iCloud → proxy calendar (optional)

You can also show busy time from your **iCloud** calendars in the proxy calendar, as plain `Busy` events with
no details. A small read-only Cloudflare Worker (`worker/`) reads iCloud over CalDAV and returns busy intervals only;
`scripts/ICloudSource.gs` passes them on to MirrorBusy. A failed iCloud read never deletes anything. Setup takes the
browser only, about 15 minutes: [`docs/icloud-setup.md`](./docs/icloud-setup.md). Design:
[`docs/icloud-spec.md`](./docs/icloud-spec.md).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/saalse/smart-sync-google-calendars/tree/main/worker)

## Troubleshooting

Having issues? See the detailed troubleshooting sections in the setup guides:

- [UI-Based Setup Troubleshooting](./docs/setup-ui-based.md#troubleshooting)
- [CLI-Based Setup Troubleshooting](./docs/setup-cli-based.md#13-troubleshooting-cli-specific-issues)

## Credits

**Vibe-coded by:** [Alex Samson](https://saalse.com) with Cursor AI assistant.

**Inspired by:** [karbassi/sync-multiple-google-calendars](https://github.com/karbassi/sync-multiple-google-calendars) by Ali Karbassi - Original concept of syncing multiple calendars with prefixes. The core sync logic has been completely rewritten to use smart updates instead of delete-and-recreate.

**BatchRequest library:** [tanaikech/BatchRequest](https://github.com/tanaikech/BatchRequest) by Tanaike - Efficient batch API request handling

---
