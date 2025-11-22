# Smart Sync Google Calendars

A free, unlimited solution to sync multiple Google calendars into one unified "Busy Time" calendar using Google Apps Script.

## Why This Project?

**The Need:** You have multiple calendars (personal, multiple work accounts) and want to:
- Share your real availability with family to find time for calls and activities
- Show teammates your actual schedule in their native calendar app (no Calendly needed)
- Consolidate calendars from different Google accounts into one view

**Why Not Use karbassi's Solution?** 

This project is inspired by [karbassi/sync-multiple-google-calendars](https://github.com/karbassi/sync-multiple-google-calendars), but completely rewrites the sync logic. The original deletes and recreates all events every time, which quickly hits Google's API limits when syncing a year ahead with frequent updates. 

**Key Features:**
- ✅ **Smart sync by changes only** - Updates, creates, or deletes only what changed
- ✅ **99% fewer API calls** - Typically 5-10 calls/day vs 600+ with original approach
- ✅ **Year-ahead syncing that actually works** - While configurable in original, smart sync makes 365 days future + 30 days past practical without hitting API limits
- ✅ **Fast execution** - < 30 seconds typical runtime
- ✅ **Free & unlimited** - No third-party services or subscriptions
- ✅ **Privacy-focused** - Descriptions excluded, runs entirely in your Google account

## Getting Started

Choose your setup method:

- **[UI-Based Setup](./docs/setup-ui-based.md)** ← Start here! Browser-only, no command-line tools needed
- **[CLI-Based Setup](./docs/setup-cli-based.md)** ← For developers who want local editing and Git workflow

## How It Works

```
┌─────────────────────┐
│ Personal Calendar   │──┐
│ (user@gmail.com)    │  │
└─────────────────────┘  │
                         │
┌─────────────────────┐  │     ┌──────────────────┐
│ Work Calendar 1     │──┼────►│   Busy Time      │──► Google or iCloud
│ (work1@company.com) │  │     │    Calendar      │    (shared)
└─────────────────────┘  │     └──────────────────┘
                         │
┌─────────────────────┐  │     Events show as:
│ Work Calendar 2     │──┘     • [personal] Dental Appointment
│ (work2@company.com) │        • [work1] Client Meeting
└─────────────────────┘        • [work2] Design Review

Google Apps Script runs automatically when
any source calendar updates (trigger-based)
```

## Features

- **Multiple Source Calendars**: Sync from 4+ calendars simultaneously
- **Automatic Prefixes**: Events tagged with source calendar name (e.g., `[personal]`, `[saalse]`)
- **Privacy Controls**: Descriptions excluded, locations included
- **Smart Filtering**: Skips "free" events, preserves conference links
- **Wide Sync Window**: 30 days past, 365 days future
- **Smart Updates**: Only syncs events that have changed (99% reduction in API calls)
- **Efficient Updates**: Uses batch API requests and pagination for speed
- **Duplicate Prevention**: Handles concurrent executions safely
- **Event-Based Triggers**: Syncs when calendars update (near-instant)
- **Timezone Independent**: Works regardless of where you travel

## What Gets Synced

| Data | Synced? | Notes |
|------|---------|-------|
| Event title | ✅ Yes | With prefix like `[personal]` |
| Start/end time | ✅ Yes | Preserves original timezone |
| Location | ✅ Yes | For context |
| Conference links | ✅ Yes | Zoom, Meet, etc. |
| Description | ❌ No | Privacy |
| Attendees | ❌ No | Privacy |
| Free/transparent events | ❌ No | Not shown as busy |

## Architecture

### How Smart Sync Works

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

## Troubleshooting

Having issues? See the detailed troubleshooting sections in the setup guides:

- [UI-Based Setup Troubleshooting](./docs/setup-ui-based.md#troubleshooting)
- [CLI-Based Setup Troubleshooting](./docs/setup-cli-based.md#troubleshooting)

## Privacy & Security

- **No external servers**: Runs entirely in Google Apps Script
- **No data sharing**: Events never leave your Google account
- **Description privacy**: Descriptions are never synced
- **You're in control**: Open source, modify as needed
- **Secure by default**: Uses Google's OAuth for authentication

## Credits

**Created by:** Alex Samson ([@saalse](https://github.com/saalse)) with Cursor AI assistant

**Inspired by:** [karbassi/sync-multiple-google-calendars](https://github.com/karbassi/sync-multiple-google-calendars) by Ali Karbassi - Original concept of syncing multiple calendars with prefixes. The core sync logic has been completely rewritten to use smart updates instead of delete-and-recreate.

**BatchRequest library:** [tanaikech/BatchRequest](https://github.com/tanaikech/BatchRequest) by Tanaike - Efficient batch API request handling

---
